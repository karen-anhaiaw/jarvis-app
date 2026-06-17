// src/transport/tls.ts
// Generates (or loads from cache) a self-signed TLS certificate for the local
// JARVIS server. Stored in ~/.jarvis/certs/ — outside the repo so it persists
// across git operations and is never committed. Re-generated automatically if
// absent or expired (validity window < 7 days remaining).
//
// Used by server.ts to upgrade from http to http2 (createSecureServer).
// --ignore-certificate-errors is set in the Electron main process so the
// renderer accepts the self-signed cert without user interaction.

import { execSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { log } from "../logger/index.js";

const CERTS_DIR = join(homedir(), ".jarvis", "certs");
const KEY_PATH = join(CERTS_DIR, "server.key");
const CERT_PATH = join(CERTS_DIR, "server.crt");

/** Minimum remaining validity (ms) before we regenerate. */
const REGEN_BEFORE_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function isCertValid(): boolean {
  if (!existsSync(KEY_PATH) || !existsSync(CERT_PATH)) return false;
  try {
    // Ask openssl when the cert expires (output: "notAfter=<date>")
    const out = execSync(`openssl x509 -enddate -noout -in "${CERT_PATH}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const match = out.match(/notAfter=(.+)/);
    if (!match) return false;
    const expiry = new Date(match[1].trim()).getTime();
    return expiry - Date.now() > REGEN_BEFORE_EXPIRY_MS;
  } catch {
    return false;
  }
}

function generateCert(): void {
  mkdirSync(CERTS_DIR, { recursive: true });
  execSync(
    `openssl req -x509 -newkey rsa:2048 -keyout "${KEY_PATH}" -out "${CERT_PATH}" ` +
      `-days 365 -nodes -subj "/CN=localhost" ` +
      `-addext "subjectAltName=IP:127.0.0.1,DNS:localhost"`,
    { stdio: "ignore" },
  );
  log.info({ keyPath: KEY_PATH, certPath: CERT_PATH }, "TLS cert generated");
}

/** Returns { key, cert } buffers for use with node:http2 createSecureServer. */
export function loadTlsCert(): { key: Buffer; cert: Buffer } {
  if (!isCertValid()) {
    generateCert();
  } else {
    log.info({ certPath: CERT_PATH }, "TLS cert loaded from cache");
  }
  return {
    key: readFileSync(KEY_PATH),
    cert: readFileSync(CERT_PATH),
  };
}
