// src/mcp/oauth.ts
import { readFileSync, writeFileSync, mkdirSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { jarvisPath } from "../core/paths.js";
import { createServer } from "node:http";
import { log } from "../logger/index.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformationMixed,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

const OAUTH_DIR = jarvisPath("oauth");

export class JarvisOAuthProvider implements OAuthClientProvider {
  private serverName: string;
  private _tokens?: OAuthTokens;
  private _clientInfo?: OAuthClientInformationMixed;
  private _codeVerifier?: string;
  private callbackPort: number;
  private fixedClientId?: string;

  // Each server gets a DETERMINISTIC port derived from its name.
  //
  // WHY deterministic (not incremental): the OAuth client is registered ONCE with the
  // dynamic-registration endpoint, and its redirect_uris (including the callback port) are
  // baked into that registration on the provider side. If the callback port changed between
  // connects (the old `nextPort++` behaviour), the redirect_uri sent to /authorize would no
  // longer match the one on file for the client_id → the provider rejects the request. With
  // Atlassian this surfaces as an opaque HTTP 500 "Internal Server Error" on /v1/authorize
  // (it should be a 400 redirect_uri_mismatch, but their error is generic). Deriving the port
  // from a stable hash of the server name guarantees the SAME port every connect, so the
  // registered redirect_uri always matches. Collisions across servers are resolved by linear
  // probing on the shared usedPorts set within a single process lifetime.
  private static readonly PORT_BASE = 9876;
  private static readonly PORT_SPAN = 1000; // ports 9876..10875
  private static usedPorts = new Set<number>();

  /** Stable non-negative hash of a string (djb2). Deterministic across process restarts. */
  private static hashName(name: string): number {
    let h = 5381;
    for (let i = 0; i < name.length; i++) {
      h = ((h << 5) + h + name.charCodeAt(i)) | 0; // h * 33 + c
    }
    return Math.abs(h);
  }

  constructor(serverName: string, oauthConfig?: { clientId?: string; callbackPort?: number }) {
    this.serverName = serverName;
    this.fixedClientId = oauthConfig?.clientId;

    // Use configured port, else derive a deterministic one from the server name.
    if (oauthConfig?.callbackPort) {
      this.callbackPort = oauthConfig.callbackPort;
    } else {
      let port =
        JarvisOAuthProvider.PORT_BASE +
        (JarvisOAuthProvider.hashName(serverName) % JarvisOAuthProvider.PORT_SPAN);
      // Linear-probe only against ports already claimed in THIS process (avoids in-run
      // collisions). The mapping stays stable across restarts because the seed is the name.
      while (JarvisOAuthProvider.usedPorts.has(port)) {
        port = JarvisOAuthProvider.PORT_BASE + ((port + 1 - JarvisOAuthProvider.PORT_BASE) % JarvisOAuthProvider.PORT_SPAN);
      }
      this.callbackPort = port;
    }
    JarvisOAuthProvider.usedPorts.add(this.callbackPort);

    mkdirSync(OAUTH_DIR, { recursive: true });
    this._tokens = this.loadFromDisk("tokens") as OAuthTokens | undefined;
    this._clientInfo = this.loadFromDisk("client") as OAuthClientInformationMixed | undefined;

    // If a fixed clientId is provided, set and persist it so the SDK skips dynamic registration
    if (this.fixedClientId && !this._clientInfo) {
      this._clientInfo = { client_id: this.fixedClientId } as OAuthClientInformationMixed;
      this.saveToDisk("client", this._clientInfo);
    }
  }

  get redirectUrl(): string {
    return `http://localhost:${this.callbackPort}/callback`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: `JARVIS MCP Client (${this.serverName})`,
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    log.info({ server: this.serverName, hasClientInfo: !!this._clientInfo, clientId: (this._clientInfo as any)?.client_id }, "OAuth: clientInformation() called");
    return this._clientInfo;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    this._clientInfo = info;
    this.saveToDisk("client", info);
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
    this.saveToDisk("tokens", tokens);
    log.info({ server: this.serverName }, "OAuth: tokens saved");
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    log.info(
      { server: this.serverName, url: authorizationUrl.toString() },
      "OAuth: authorization required — opening browser",
    );

    const { exec } = await import("node:child_process");
    const cmd =
      process.platform === "darwin"
        ? "open"
        : process.platform === "win32"
          ? "start"
          : "xdg-open";
    exec(`${cmd} "${authorizationUrl.toString()}"`);

    console.log(
      `\n[OAuth] Authorization required for MCP server '${this.serverName}'`,
    );
    console.log(`        Browser opened. Complete the login flow.`);
    console.log(
      `        Waiting for callback on port ${this.callbackPort}...\n`,
    );
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
    this.saveToDisk("verifier", { codeVerifier });
  }

  codeVerifier(): string {
    if (this._codeVerifier) return this._codeVerifier;
    const stored = this.loadFromDisk("verifier") as
      | { codeVerifier: string }
      | undefined;
    return stored?.codeVerifier ?? "";
  }

  invalidateCredentials(
    scope: "all" | "client" | "tokens" | "verifier" | "discovery",
  ): void {
    if (scope === "all" || scope === "tokens") {
      this._tokens = undefined;
      this.deleteFromDisk("tokens");
    }
    if (scope === "all" || scope === "client") {
      this._clientInfo = undefined;
      this.deleteFromDisk("client");
    }
    if (scope === "all" || scope === "verifier") {
      this._codeVerifier = undefined;
      this.deleteFromDisk("verifier");
    }
    log.info({ server: this.serverName, scope }, "OAuth: credentials invalidated");
  }

  // --- Device Code Flow (RFC 8628) ---

  /**
   * Discovers OAuth metadata for a server URL.
   * Returns the authorization server metadata if device code flow is supported.
   */
  async discoverDeviceCodeSupport(serverUrl: string): Promise<{
    deviceAuthorizationEndpoint: string;
    tokenEndpoint: string;
    registrationEndpoint?: string;
  } | null> {
    try {
      const origin = new URL(serverUrl).origin;
      const resourceMeta = await fetch(`${origin}/.well-known/oauth-protected-resource`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

      const authServerUrl = resourceMeta?.authorization_servers?.[0];
      if (!authServerUrl) return null;

      const authMeta = await fetch(`${authServerUrl}/.well-known/oauth-authorization-server`)
        .then(r => r.ok ? r.json() : null)
        .catch(() => null);

      if (!authMeta?.device_authorization_endpoint) return null;

      return {
        deviceAuthorizationEndpoint: authMeta.device_authorization_endpoint,
        tokenEndpoint: authMeta.token_endpoint,
        registrationEndpoint: authMeta.registration_endpoint,
      };
    } catch (err) {
      log.debug({ server: this.serverName, err }, "OAuth: device code discovery failed");
      return null;
    }
  }

  /**
   * Runs the OAuth Device Code flow (RFC 8628).
   * Non-blocking — polls for token in background and resolves when user completes auth.
   */
  async deviceCodeFlow(serverUrl: string): Promise<void> {
    const discovery = await this.discoverDeviceCodeSupport(serverUrl);
    if (!discovery) {
      throw new Error("Server does not support device code flow");
    }

    const { deviceAuthorizationEndpoint, tokenEndpoint, registrationEndpoint } = discovery;

    // Register client dynamically if needed
    let clientInfo = this.clientInformation();
    if (!clientInfo && registrationEndpoint) {
      const regResponse = await fetch(registrationEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_name: this.clientMetadata.client_name,
          grant_types: ["urn:ietf:params:oauth:grant-type:device_code", "refresh_token"],
          response_types: [],
          token_endpoint_auth_method: "none",
        }),
      });
      if (regResponse.ok) {
        clientInfo = await regResponse.json();
        this.saveClientInformation(clientInfo!);
      }
    }

    const clientId = (clientInfo as Record<string, unknown>)?.client_id as string
      ?? this.clientMetadata.client_name;

    // Request device code
    const deviceResponse = await fetch(deviceAuthorizationEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: clientId }),
    });

    if (!deviceResponse.ok) {
      throw new Error(`Device authorization failed: ${deviceResponse.status} ${await deviceResponse.text()}`);
    }

    const deviceData = await deviceResponse.json();
    const {
      device_code,
      user_code,
      verification_uri,
      verification_uri_complete,
      interval = 5,
      expires_in = 300,
    } = deviceData;

    // Show user code in terminal
    const displayUri = verification_uri_complete ?? verification_uri;
    console.log(`\n[OAuth] MCP server '${this.serverName}' requires authentication`);
    console.log(`        Go to: ${displayUri}`);
    console.log(`        Enter code: ${user_code}\n`);

    log.info(
      { server: this.serverName, verificationUri: displayUri, userCode: user_code },
      "OAuth: device code flow started",
    );

    // Open browser to verification URI
    const { exec } = await import("node:child_process");
    const cmd = process.platform === "darwin" ? "open"
      : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${cmd} "${displayUri}"`);

    // Poll for token
    const deadline = Date.now() + expires_in * 1000;
    let pollInterval = interval * 1000;

    while (Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, pollInterval));

      const tokenResponse = await fetch(tokenEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code,
          client_id: clientId,
        }),
      });

      if (tokenResponse.ok) {
        const tokens = await tokenResponse.json();
        this.saveTokens(tokens);
        log.info({ server: this.serverName }, "OAuth: device code flow completed");
        return;
      }

      const errorData = await tokenResponse.json().catch(() => ({ error: "unknown" }));

      if (errorData.error === "authorization_pending") {
        continue;
      } else if (errorData.error === "slow_down") {
        pollInterval += 5000;
        continue;
      } else {
        throw new Error(`Token polling failed: ${errorData.error} ${errorData.error_description ?? ""}`);
      }
    }

    throw new Error("Device code flow timed out");
  }

  // --- Callback server ---

  /**
   * Starts a temporary HTTP server to receive the OAuth callback.
   * Returns the authorization code from the redirect.
   */
  waitForCallback(): Promise<string> {
    return new Promise((resolve, reject) => {
      const server = createServer((req, res) => {
        const url = new URL(
          req.url ?? "",
          `http://localhost:${this.callbackPort}`,
        );

        if (url.pathname === "/callback") {
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(
              "<html><body><h1>Authorization Failed</h1><p>You can close this window.</p></body></html>",
            );
            server.close();
            reject(new Error(`OAuth error: ${error}`));
            return;
          }

          if (code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end(
              "<html><body><h1>Authorization Successful</h1><p>You can close this window. JARVIS is connecting...</p></body></html>",
            );
            server.close();
            resolve(code);
            return;
          }
        }

        res.writeHead(404);
        res.end();
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        log.error({ port: this.callbackPort, err: err.message }, "OAuth: callback server error");
        reject(new Error(`OAuth callback server failed on port ${this.callbackPort}: ${err.message}`));
      });

      server.listen(this.callbackPort, () => {
        log.debug(
          { port: this.callbackPort },
          "OAuth: callback server listening",
        );
      });

      // Timeout after 5 minutes
      setTimeout(() => {
        server.close();
        reject(new Error("OAuth: callback timeout (5 minutes)"));
      }, 5 * 60 * 1000);
    });
  }

  // --- Persistence helpers ---

  private filePath(key: string): string {
    return join(OAUTH_DIR, `${this.serverName}_${key}.json`);
  }

  private loadFromDisk(key: string): unknown {
    const path = this.filePath(key);
    if (!existsSync(path)) return undefined;
    try {
      return JSON.parse(readFileSync(path, "utf-8"));
    } catch {
      return undefined;
    }
  }

  private saveToDisk(key: string, data: unknown): void {
    writeFileSync(this.filePath(key), JSON.stringify(data, null, 2));
  }

  private deleteFromDisk(key: string): void {
    const path = this.filePath(key);
    if (existsSync(path)) {
      unlinkSync(path);
    }
  }
}
