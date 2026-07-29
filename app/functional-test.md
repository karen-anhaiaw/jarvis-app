# JARVIS Core — Functional Tests

> BDD scenarios for validating the JARVIS runtime end-to-end.
> Execute these after any code change, dependency update, or architecture refactor.

## Feature: Startup & Initialization

### Scenario: Clean boot with all core pieces loaded

```gherkin
Given JARVIS is installed with default settings
When the process starts
Then piece_list should show all core pieces:
  | Piece              | Running | Protected |
  | jarvis-core        | true    | true      |
  | capability-executor| true    | true      |
  | capability-loader  | true    | true      |
  | chat               | true    | true      |
  | model-router       | true    | false     |
  | mcp-manager        | true    | false     |
  | grpc               | true    | false     |
  | hud-core-node      | true    | false     |
  | cron               | true    | false     |
  | delegate-task      | true    | false     |
  | diff-viewer        | true    | false     |
  | choice-prompt      | true    | false     |
  | plugin-manager     | true    | false     |
  | turn-inspector     | true    | false     |
And GET /hud should return a JSON with reactor.status "online"
And token-counter should NOT appear in piece_list (it is a provider-scoped HUD
  registered by ai/<provider>/metrics-hud.ts, not a Piece)
And GET /hud should return components for all visible pieces
And the HUD Electron window should render without errors
```

### Scenario: Disabled piece is skipped on boot

```gherkin
Given settings.user.json has mcp-manager with enabled: false
When JARVIS boots
Then piece_list should show mcp-manager as enabled: false, running: false
And the graph registry should show mcp-manager with status "disabled"
```

### Scenario: Startup prompt is delivered on boot

```gherkin
Given a file exists at ~/.jarvis/startup-prompt.txt with content "Testing startup"
When JARVIS boots
Then the startup prompt should be consumed (file deleted)
And the main session should receive a [SYSTEM] message containing the prompt
And the AI should process it as informational context (not execute it as a command)
```

### Scenario: Conversation history is restored on restart

```gherkin
Given JARVIS has processed at least 3 messages in the main session
When JARVIS is restarted (jarvis_reset)
Then the main session should restore previous message history
And the AI should have memory of the previous conversation
```

## Feature: Bootstrap & Path Resolution

> INVARIANT: `~/.jarvis/` holds all runtime state. `jarvis-app/` is source code only.
> Nothing at runtime may resolve a path against the source tree or the cwd.
>
> STATUS (2026-07-29): GREEN. Bootstrap implemented in `app/src/core/bootstrap.ts`,
> called from `main.ts` as the first step of every boot. 13/13 unit tests pass.
> `config/index.ts` systemPromptPath now resolves via `jarvisPath()` instead of
> `"./jarvis-system.md"` (cwd-relative). Remaining RED items: silent-failure on
> missing config (no log warning yet), and cp/find/openssl still shell-out in
> `plugin-manager.ts` (skills copy) and `diff-viewer.ts` (`/tmp` literal).

### Scenario: First boot populates ~/.jarvis from the shipped source

```gherkin
Given ~/.jarvis does not exist
When JARVIS boots
Then ~/.jarvis should be created with sessions/, logs/, certs/, oauth/, plugins/
And ~/.jarvis/settings.json should be copied from the shipped defaults
And ~/.jarvis/jarvis-system.md should be copied from the shipped source
And ~/.jarvis/mcp.json should be created as an empty template
And ~/.jarvis/settings.user.json should be created as a template
And the boot should not depend on any external shell script
```

### Scenario: Boot is idempotent and refreshes shipped defaults

```gherkin
Given ~/.jarvis is already populated from a previous version
When JARVIS boots again
Then shipped defaults (settings.json, jarvis-system.md) should be overwritten
  so upgrades propagate
And user-owned files (settings.user.json, mcp.json, secrets/) must NOT be touched
And booting N times should leave the same state as booting once
```

### Scenario: Runtime never reads from the source tree

```gherkin
Given JARVIS is running
When any runtime path is resolved (system prompt, capabilities, settings, sessions)
Then it should resolve under jarvisHome()
And no runtime path should be built from process.cwd()
And moving or deleting the jarvis-app checkout after boot should not break
  an already-bootstrapped instance
```

### Scenario: Missing configuration is reported, never silent

```gherkin
Given ~/.jarvis/settings.json does not exist
When settings.load() is called
Then a warning should be logged naming the missing file
And JARVIS should not present itself as healthy with zero configuration
```

### Scenario: HOME is not set (Windows native)

```gherkin
Given the process was started without a HOME environment variable
  (cmd.exe and PowerShell do not set it; only Git Bash does)
When a path containing "~" is expanded
Then it should expand via os.homedir(), never via process.env.HOME
And no directory literally named "~" should ever be created
And the tool-context preamble must not tell the model
  "The user's home directory is undefined"
```

### Scenario: Bootstrap runs without a POSIX shell

```gherkin
Given JARVIS is started on Windows with no bash available
When the boot bootstrap runs
Then directory creation and file copies should use node:fs APIs
And no step should shell out to cp, find, diff, or openssl
And the resulting ~/.jarvis should be identical to the one produced on Unix
```

### Scenario: JARVIS_HOME override is honoured everywhere

```gherkin
Given JARVIS_HOME is set to a custom directory
When JARVIS boots
Then every runtime path should resolve under that directory
And two instances with different JARVIS_HOME values should not share state
```

## Feature: AI Request/Response Cycle

### Scenario: Simple text prompt

```gherkin
Given JARVIS is online with the main session idle
When a user sends "What is 2+2?" via POST /chat/send
Then the session state should transition: online → processing → online
And the HUD reactor should reflect each state transition
And the chat should display a response containing "4"
And the token counter should update with input/output token counts
```

### Scenario: Prompt triggers tool use

```gherkin
Given JARVIS is online
When a user sends "List the files in the current directory"
Then the session state should transition: online → processing → waiting_tools → processing → online
And the chat should show a tool execution bar for "list_dir"
And the tool result should be incorporated into the final response
And the response should contain file names from the working directory
```

### Scenario: Multi-tool response

```gherkin
Given JARVIS is online
When a user sends a prompt that requires multiple independent tool calls
Then all tools should execute in parallel (single capability.request with multiple calls)
And each tool should emit tool_start and tool_done events on ai.stream
And the final response should synthesize results from all tools
```

### Scenario: Abort during processing

```gherkin
Given JARVIS is processing a prompt (state = processing or waiting_tools)
When the user sends POST /chat/abort
Then the current operation should be cancelled
And an "aborted" event should be emitted on ai.stream
And the session should return to "idle" state
And the HUD reactor should show "ONLINE"
```

### Scenario: Queued prompts are drained after completion

```gherkin
Given JARVIS is processing a prompt (state = processing)
When a second prompt arrives via ai.request
Then the second prompt should be queued (not abort the first)
And when the first prompt completes, the queued prompt should be processed automatically
```

## Feature: Pieces — Lifecycle & Graph

### Scenario: All pieces appear in the core node graph

```gherkin
Given JARVIS is running with all default pieces started
When graphRegistry.getTree() is called
Then the tree should contain a root node "jarvis-core"
And every running piece should appear as a child of "jarvis-core" with status "running"
And disabled pieces should appear with status "disabled"
And the tree should NOT contain any hardcoded plugin-specific nodes
```

Verify with:
```
jarvis_eval('const gr = (await import("./core/graph-registry.js")).graphRegistry; return JSON.stringify(gr.getTree())')
```

### Scenario: Enable a disabled piece

```gherkin
Given mcp-manager is disabled in settings
When piece_enable("mcp-manager") is called
Then piece_list should show mcp-manager as enabled: true, running: true
And settings.user.json should have mcp-manager.enabled = true
And the graph registry should show mcp-manager with status "running"
```

### Scenario: Disable a non-protected piece

```gherkin
Given cron is running
When piece_disable("cron") is called
Then piece_list should show cron as enabled: false, running: false
And settings.user.json should have cron.enabled = false
And the graph registry should show cron with status "disabled"
```

### Scenario: Cannot disable a protected piece

```gherkin
Given jarvis-core is running
When piece_disable("jarvis-core") is called
Then the response should contain error: "protected"
And jarvis-core should remain running
```

### Scenario: Dynamic piece registration from plugins

```gherkin
Given a plugin is installed with a piece "my-piece"
When the plugin is loaded by PluginManager
Then PieceManager.registerDynamic should start the piece
And piece_list should include "my-piece" as running
And the graph registry should include "my-piece" as a node with status "running"
And settings should have a default entry for "my-piece"
When the plugin is removed
Then the piece should be unregistered from graph and PieceManager
```

## Feature: HUD — Panel State Persistence

### Scenario: Panel layout is saved on drag/resize

```gherkin
Given a user drags the chat panel to position (100, 200) and resizes to (400, 300)
When the layout is saved via POST /hud/layout
Then settings.user.json should have chat-output.config.layout = { x: 100, y: 200, width: 400, height: 300 }
And on restart, the panel should appear at the saved position/size
```

### Scenario: Panel visibility is persisted

```gherkin
Given the token-counter panel is visible
When the user closes it via the HUD (POST /hud/hide)
Then settings.user.json should have token-counter.visible = false
And on restart, the panel should not be visible
When hud_show("token-counter") is called
Then settings.user.json should have token-counter.visible = true
And the panel should reappear
```

### Scenario: Detach/reattach persists to settings

```gherkin
Given the chat panel is attached (in the main HUD window)
When the user detaches it via POST /hud/detach
Then settings.user.json should have chat-output.config.detached = true
And the panel should open in a separate Electron window
When the user reattaches it via POST /hud/reattach
Then settings.user.json should have chat-output.config.detached = false
And the panel should return to the main HUD
```

### Scenario: Detached window layout persists

```gherkin
Given a panel is detached to a separate window
When the user moves/resizes the detached window
Then POST /hud/detach-layout should save position and size to settings.user.json
And on restart, GET /hud/detached should return the saved layout
```

### Scenario: Ephemeral panels do NOT persist

```gherkin
Given a plugin registers an ephemeral panel (ephemeral: true)
When the user moves or resizes the panel
Then settings.user.json should NOT contain an entry for that panel's layout
And when the panel is closed, no settings entry remains
```

### Scenario: hud_layout tool persists layout

```gherkin
Given the grpc panel exists
When hud_layout("grpc", 500, 100, 300, 200) is called
Then settings.user.json should have grpc.config.layout = { x: 500, y: 100, width: 300, height: 200 }
And the HUD should update the panel position in real-time
```

## Feature: Settings Integrity

### Scenario: Enable/disable reflects immediately in settings

```gherkin
Given cron is running (enabled: true in settings)
When piece_disable("cron") is called
Then reading settings.user.json should show cron.enabled = false
When piece_enable("cron") is called
Then reading settings.user.json should show cron.enabled = true
And no stale or orphan entries should exist in settings
```

### Scenario: Settings survive restart

```gherkin
Given various settings have been modified (layouts, visibility, detach state)
When JARVIS is restarted
Then all modified settings should be preserved
And pieces should start with saved enabled/disabled state
And panels should appear with saved position/size/visibility
```

### Scenario: Two-layer settings merge correctly

```gherkin
Given ~/.jarvis/settings.json has default piece configurations (shipped defaults)
And ~/.jarvis/settings.user.json has user overrides
When settings.load() is called
Then user values should override defaults
And settings.save() should write ONLY to ~/.jarvis/settings.user.json
And ~/.jarvis/settings.json should remain untouched
And every top-level field of Settings must survive the merge
  (deepMerge in settings.ts is FIELD-EXPLICIT — a field absent from it is
   silently dropped; adding a field to Settings requires adding it there too)
```

## Feature: HUD & SSE Streaming

### Scenario: SSE stream delivers state changes

```gherkin
Given a client is connected to GET /hud-stream
When a piece publishes a hud.update event
Then the client should receive an SSE delta with the updated component
And the delta should only be sent if the component data actually changed (dirty check)
```

### Scenario: SSE is quiet during idle

```gherkin
Given JARVIS is idle (no prompts being processed)
And a client is connected to GET /hud-stream
When 10 seconds pass with no user interaction
Then the number of SSE deltas received should be 0
And the hud-core-node 500ms timer and token-counter 1s timer should be suppressed by dirty check
```

### Scenario: Reactor status syncs with core node graph

```gherkin
Given the HUD is rendering the core node graph
When the session state changes from "online" to "processing"
Then the reactor delta should include the new status
And the graphRegistry should update jarvis-core status
And the core node label should display "PROCESSING"
And when idle, it should display "ONLINE"
```

### Scenario: GET /hud returns full snapshot

```gherkin
Given JARVIS is running with pieces active
When a client requests GET /hud
Then the response should include:
  - reactor: { status, coreLabel, coreSubLabel }
  - components: array of all registered HUD pieces
And each component should have: id, name, status, visible, position, size, data
```

### Scenario: Token counter displays streaming progress

```gherkin
Given the AI is streaming a response
Then the token counter panel should show:
  - A streaming verb (e.g. "Analyzing…")
  - Elapsed time counting up
  - Estimated output tokens
And when streaming completes, the display should switch to model name
```

## Feature: Chat Piece

### Scenario: Chat timeline shows only owned sessions

```gherkin
Given ChatPiece routes SSE events per-session (events keyed by target sessionId in the SSE pool map)
When an ai.stream event arrives with target "main"
Then only the SSE pool for sessionId="main" receives the event
When an ai.stream event arrives with target "some-plugin-session"
Then the main SSE pool does NOT receive it
And only SSE clients connected to ?sessionId=some-plugin-session receive it
```

### Scenario: Slash command interception

```gherkin
Given a slash command "/test" is registered via CapabilityRegistry
When the user sends "/test args" via POST /chat/send
Then the slash command handler should be invoked with args "args"
And the message should appear in chat as a user message
And the result should appear as a system message
And the prompt should NOT be sent to the AI session
```

### Scenario: Chat history hydration

```gherkin
Given the main session has processed messages
When GET /chat/history is requested
Then the response should contain ChatEntry[] with user and assistant messages
And tool_result messages should be filtered out
And tool_use blocks should appear as capability entries
```

## Feature: JarvisCore — Session Ownership

### Scenario: JarvisCore processes owned sessions only

```gherkin
Given JarvisCore owns sessions matching ["main", /^grpc-/]
When an ai.request arrives with target "main"
Then JarvisCore should process it
When an ai.request arrives with target "grpc-client1"
Then JarvisCore should process it
When an ai.request arrives with target "custom-session"
Then JarvisCore should NOT process it (no subscriber picks it up)
```

### Scenario: Plugins can register session patterns

```gherkin
Given a plugin calls jarvisCore.registerSessionPattern(/^plugin-/)
When an ai.request arrives with target "plugin-worker-1"
Then JarvisCore should process it
```

### Scenario: ReplyTo routing works generically

```gherkin
Given an ai.request arrives with target "main" and replyTo "some-session"
When the AI completes its response
Then JarvisCore should publish the response to target "some-session"
And the response should be prefixed with "[JARVIS]"
```

## Feature: Plugin System

### Scenario: Install a plugin from GitHub

```gherkin
Given a valid plugin exists at github.com/user/jarvis-plugin-test
When plugin_install is called with the repo URL
Then the plugin should be cloned to ~/.jarvis/plugins/
And npm install should run if package.json exists
And the plugin's pieces should be loaded, started, and registered in graph
And the plugin should appear in plugin_list as enabled
And settings should contain the plugin entry
```

### Scenario: Plugin renderer loads via esbuild

```gherkin
Given a plugin has a renderer at renderers/MyRenderer.tsx
When the HUD requests /plugins/<name>/renderers/MyRenderer.js
Then the server should compile the TSX via esbuild on-the-fly
And the output should include the React banner (window.__JARVIS_REACT destructure)
And the compiled JS should be cached by mtime (subsequent requests skip compilation)
```

### Scenario: Plugin context.md is injected into system prompt

```gherkin
Given a plugin has a context.md file
When the plugin is enabled
Then the content of context.md should appear in the system prompt
And it should be included in the plugin context block
```

### Scenario: Plugin renderer ErrorBoundary isolates crashes

```gherkin
Given a plugin renderer throws an error at render time
When the HUD renders that plugin panel
Then only the broken panel shows "⚠ Renderer crashed" with the error message
And the rest of the HUD continues working normally
```

### Scenario: Disable and re-enable a plugin

```gherkin
Given a plugin is installed and running
When plugin_disable is called
Then the plugin's pieces should be stopped and unregistered from graph
And its tools should be unregistered
And its context should be removed from the system prompt
When plugin_enable is called
Then the plugin should be reloaded and all pieces restarted
And its pieces should reappear in graph
```

### Scenario: Remove a plugin completely

```gherkin
Given a plugin is installed
When plugin_remove is called
Then the plugin directory should be deleted from ~/.jarvis/plugins/
And the plugin entry should be removed from settings
And all its pieces should be unregistered
```

## Feature: Cron Scheduling

### Scenario: Create a one-shot timer

```gherkin
Given JARVIS is online
When cron_create is called with cron "once:5s", prompt "Say hello" from session "main"
Then a job should appear in cron_list
And the job's target should be "main" (auto-derived from the calling session)
And after ~5 seconds, the prompt "Say hello" should be sent to session "main"
And the job should be removed from cron_list after execution
And the one-shot job should NOT be persisted in settings.user.json under cron.jobs
```

### Scenario: Create a recurring timer

```gherkin
Given JARVIS is online
When cron_create is called with cron "*/1 * * * *", prompt "Status check" from session "main"
Then the prompt should be sent every 1 minute to session "main"
And the job should persist in cron_list
And the recurring job should be persisted in settings.user.json under cron.jobs with target "main"
When cron_delete is called with the job ID
Then the recurring timer should stop
And the job should be removed from cron_list
And the entry should be removed from settings.user.json
```

### Scenario: target is auto-derived from the calling session

```gherkin
Given JARVIS is online
When cron_create is called from session "main" (no target field accepted)
Then the job's target must be "main"
When cron_create is called from session "actor-alice"
Then the job's target must be "actor-alice"
And the LLM must NOT be able to specify target explicitly (field absent from schema)
```

### Scenario: persisted recurring jobs keep original target across restart

```gherkin
Given a recurring cron job was created from session "actor-bob" with target "actor-bob"
When JARVIS restarts
Then the job should be restored with target "actor-bob"
And subsequent triggers should fire to session "actor-bob"
```

### Scenario: delegate mode — cron fires ephemeral worker directly

```gherkin
Given JARVIS is online
When cron_create is called with cron "once:10s", prompt "Summarize: hello world", mode "delegate", role "generic", model "haiku"
Then a job should appear in cron_list with mode "delegate"
And after ~10 seconds, NO prompt should be sent to the calling session's LLM
And instead, an ephemeral worker should run with role "generic" and model "haiku"
And the worker's summary should arrive in the calling session as "[CRON delegate \"<id>\"] <summary>"
And the one-shot delegate job should be removed from cron_list after execution
```

### Scenario: delegate mode — error is reported to reply_to session

```gherkin
Given JARVIS is online
When cron_create is called with mode "delegate" and role "nonexistent-role"
And the job fires
Then the calling session should receive "[CRON delegate \"<id>\" ERROR] Unknown role: nonexistent-role..."
```

### Scenario: delegate mode — reply_to routes result to different session

```gherkin
Given JARVIS is online and session "main" exists
When cron_create is called from session "actor-worker" with mode "delegate", reply_to "main"
And the job fires
Then the delegate summary should arrive in session "main" (not "actor-worker")
```

### Scenario: catch_up — missed daily slot fires immediately on restore

```gherkin
Given a recurring daily job at "09:00" with catch_up: true, lastRun 2 days ago
When JARVIS restarts at 13:00 (slot already missed today)
Then the job should fire within 1s of restore (catch-up execution)
And the next scheduled run should be tomorrow at 09:00
```

### Scenario: no catch_up — missed daily slot is skipped

```gherkin
Given a recurring daily job at "09:00" with catch_up: false (default), lastRun 2 days ago
When JARVIS restarts at 13:00
Then the job should NOT fire immediately
And the next scheduled run should be tomorrow at 09:00
```

### Scenario: catch_up — only applies to daily/weekly, not interval

```gherkin
Given a recurring interval job "*/5 * * * *" with catch_up: true
When JARVIS restarts after a missed run
Then catch_up has no effect (interval already uses elapsed-time scheduling)
And the job should fire at the normal next interval slot
```

## Feature: Context Compaction

### Scenario: Automatic compaction when context exceeds threshold

```gherkin
Given compaction is enabled with thresholdPercent 83.5
When the context window usage exceeds 83.5% of max tokens
Then compaction should be triggered automatically
And the ai.stream should emit a "compaction" event
And the token counter should show updated context usage (lower than before)
And the system.event should record the compaction with engine info
```

### Scenario: Force compaction via /compact slash command

```gherkin
Given JARVIS is running with conversation history in the main session
When the user types "/compact" in the chat input
Then the slash command should be intercepted (not sent to AI)
And the chat should show "✅ Context compacted successfully."
And the ai.stream should emit a "compaction" event with engine "fallback"
And the session messages should be replaced with a summary (2 messages: user summary + assistant ack)
And the session should be saved to disk after compaction
```

### Scenario: /compact when session is busy

```gherkin
Given JARVIS is processing a prompt in the main session
When the user types "/compact" in the chat input
Then the chat should show "⚠️ Session is busy — wait for it to finish before compacting."
And no compaction should be triggered
```

### Scenario: /compact appears in slash menu

```gherkin
Given the user types "/" in the chat input
When the slash menu opens
Then "/compact" should appear in the "system" category
And its description should be "Force context compaction — summarizes conversation to free tokens"
```

## Feature: Model Switching

### Scenario: Switch between providers

```gherkin
Given JARVIS is running on claude-sonnet-4-6
When model_set is called with model "gpt-4o"
Then the provider should switch to OpenAI
And model_get should return { model: "gpt-4o", provider: "openai" }
And the token counter should display the new model name
And subsequent prompts should use the new provider
```

## Feature: gRPC Server

### Scenario: gRPC lifecycle

```gherkin
Given grpc_status shows the server is running
When grpc_stop is called
Then the server should shut down gracefully
And grpc_status should show { running: false }
When grpc_start is called
Then the server should start on the configured port
And grpc_status should show { running: true }
```

### Scenario: gRPC target routing is generic

```gherkin
Given the gRPC server is running
When a client sends a message with target "some-session"
Then the sessionId should be "some-session" (used directly, no prefix)
When a client sends a message without a target but with clientId "c1"
Then the sessionId should be "grpc-c1"
```

## Feature: EventBus

### Scenario: Publish and subscribe

```gherkin
Given a subscriber is listening on channel "ai.stream"
When a message is published to "ai.stream" with target "main"
Then the subscriber should receive the message
And the message should include source, target, and event fields
```

### Scenario: Bus stats track events

```gherkin
Given the bus has processed events
When bus.stats is checked
Then it should report total subscription count and total event count
```

## Feature: Capabilities

### Scenario: File system capabilities are loaded

```gherkin
Given JARVIS starts with the capabilities/ directory containing JSON definitions
When CapabilityLoaderPiece loads
Then the following LOCAL capabilities should be registered (type "script", spawned via the loader):
  bash, edit_file, glob, grep, list_dir,
  multi_edit_file, read_file, write_file,
  jarvis_reset, hud_screenshot,
  web_fetch_local, web_search_local
And the following SERVER-SIDE capabilities should be registered (type "server", no local process):
  web_fetch      (serverToolType web_fetch_*)
  web_search     (serverToolType web_search_*)
  code_execution (serverToolType code_execution_*)
And clear_session should also be registered (registered inline by main.ts:147;
  its JSON is parked as capabilities/clear-session.json.disabled and is NOT loaded)
And each local capability should be callable and return results
And server-side capabilities should be forwarded to the provider, never spawned locally
```

### Scenario: jarvis_eval provides runtime introspection

```gherkin
Given JARVIS is running
When jarvis_eval is called with code "return bus.stats.events"
Then it should return the current event count (a number)
And it should have access to: bus, capabilityRegistry, sessions, providerRouter, config, pieces, jarvisCore, chatPiece
```

### Scenario: session_info returns session metadata

```gherkin
Given the main session exists
When session_info is called
Then it should return sessionId, state, messageCount, provider, model,
  systemTokensEstimate, toolsTokensEstimate, createdAt
And messageCount should be > 0 if messages have been exchanged
And the reported model should be the session's EFFECTIVE model
  (peekModel() / stickyModelOverride), not the global config.model
```

### Scenario: Diff viewer capabilities work

```gherkin
Given the diff-viewer piece is running
When hud_show_diff is called with before/after content
Then a diff tab should appear in the HUD
When hud_show_file is called with a file path
Then a file viewer tab should appear with syntax highlighting
When hud_compare_files is called with two file paths
Then a side-by-side comparison should appear
```

## Feature: MCP Manager

### Scenario: Canonical config path

```gherkin
Given JARVIS is installed
When the McpManager starts with no explicit configPath argument
Then it reads `~/.jarvis/mcp.json` (user home), NOT `<cwd>/mcp.json`
And an explicit configPath argument overrides it (used by tests only)
And there is NO user-override layer for MCP — mcp.json is the single file
```

### Scenario: mcp_refresh adds a new server

```gherkin
Given ~/.jarvis/mcp.json lists [prometheus-mcp, clojure]
When the user edits the file to add a new server "foo" and calls mcp_refresh
Then the tool returns a string including "Added: foo"
And mcp_list shows "foo" with status:"disconnected"
And if foo has autoConnect:true, the server auto-connects after refresh
```

### Scenario: mcp_refresh removes a deleted server

```gherkin
Given a connected server "bar" exists in memory
When the user removes "bar" from ~/.jarvis/mcp.json and calls mcp_refresh
Then the tool returns a string including "Removed: bar"
And mcp_list no longer contains "bar"
And if the server had an open client, it is closed gracefully
```

### Scenario: mcp_refresh detects CHANGED config (new)

```gherkin
Given a server "prometheus-mcp" exists with command:"uv" and args:["run","python","-m","x"]
And the server is currently connected
When the user edits the config to command:"/path/to/run_stdio.sh" and args:[]
And calls mcp_refresh
Then the tool returns a string including "Updated: prometheus-mcp"
And the in-memory server.config.command is now "/path/to/run_stdio.sh"
And the previous client is closed
And auto-reconnect fires: server transitions through disconnected → connecting → (connected | error)
And server.toolNames is reset to [] before reconnect completes
```

### Scenario: mcp_refresh is a no-op when only whitespace changes

```gherkin
Given a server "alpha" exists in config
When the user re-saves mcp.json with pretty-printed indentation but same values
And calls mcp_refresh
Then the tool returns "No changes. Total: N servers"
And no reconnect is triggered
```

### Scenario: configsEqual semantics

```gherkin
Given two McpServerConfig objects
Then configsEqual treats them as equal when they have the same top-level keys and values,
     regardless of key ORDER (top-level or nested env/headers)
And unequal when args order differs (args is meaningful-order)
And unequal when command, url, type, or autoConnect differ
And equal when one has an explicit `env: undefined` and the other omits `env`
```

### Scenario: autoConnect=true is picked up on refresh

```gherkin
Given a disconnected server "beta" with autoConnect:false
When the user flips autoConnect to true in config and calls mcp_refresh
Then "beta" is reported as "Updated: beta"
And an auto-connect attempt fires without manual mcp_connect
```

## Feature: Choice Prompt (jarvis_ask_choice)

### Scenario: Tool is registered (dual shape — single + multi-question)

```gherkin
Given the choice-prompt piece is running
When session_get_tools filter="jarvis_ask_choice"
Then the tool is listed with schema containing BOTH shapes:
  - Single: question, options, multi, allow_other (legacy, backward-compat)
  - Multi: questions[] with nested {question, options, multi, allow_other}
And the tool description documents both the single and multi response formats
```

### Scenario: Single-choice card renders inline in chat

```gherkin
Given a live chat session with SSE connected
When the AI calls jarvis_ask_choice with question "Which DB?" and 3 options
Then the chat SSE broadcasts event type:"choice" with choice_id, question, options, multi:false
And ChatPanel appends an entry of kind:"choice" to the timeline
And the ChoiceCard renders radio buttons (one per option)
And the CONFIRM button is disabled until a selection is made
And NO capability entry for jarvis_ask_choice appears (suppressed in favor of the card)
```

### Scenario: Single choice submission sends [choice] prompt

```gherkin
Given a pending single-choice card "Which DB? → Postgres|DynamoDB|Redis"
When the user clicks "Postgres" and presses CONFIRM
Then POST /chat/send is called with prompt exactly "[choice] Which DB? → Postgres"
And the card becomes answered (opacity reduced, inputs disabled)
And the answer summary "→ Postgres" renders below the options
And the AI receives the prompt as the next user turn
```

### Scenario: Multi-choice selects multiple values

```gherkin
Given the AI calls jarvis_ask_choice with multi:true and 4 options
When the user checks options A and C
And presses CONFIRM
Then POST /chat/send is called with prompt "[choice] <question> → A-label, C-label"
And the answer summary shows both labels joined by ", "
```

### Scenario: "Other (write your own)" with free-text input

```gherkin
Given a choice card with allow_other:true (default)
When the user selects "Other (write your own)"
Then a textarea appears below with autofocus
And CONFIRM remains disabled until the textarea has non-empty content
When the user types "Cassandra" and presses Enter (or clicks CONFIRM)
Then POST /chat/send is called with prompt "[choice] <question> → Cassandra"
And the answered card shows the free text in italic quotes
```

### Scenario: allow_other=false hides the "Other" option

```gherkin
Given the AI calls jarvis_ask_choice with allow_other:false
Then the choice card renders WITHOUT the "Other (write your own)" row
```

### Scenario: Persistence — answered choice survives session reload

```gherkin
Given the user has completed a single-choice prompt in the main session
When GET /chat/history?sessionId=main is fetched
Then the response contains an entry with kind:"choice", question, options, multi
And that entry has answer field populated with the chosen value(s)
And the preceding assistant text (if any) appears before the choice entry
And the "[choice]" user message is NOT emitted as a separate entry (consumed as the answer)
```

### Scenario: Persistence — pending choice (no answer yet) survives reload

```gherkin
Given a choice prompt was published but the user hasn't clicked CONFIRM
And JARVIS is restarted before submission
When GET /chat/history?sessionId=main returns the history
Then the choice entry exists with no answer field
And the ChoiceCard renders in its pending state (inputs enabled, CONFIRM present)
When the user now clicks an option and CONFIRM
Then the submission flow proceeds normally
```

### Scenario: "Other" free text round-trips through reload

```gherkin
Given the user answered a choice via "Other" with text "Cassandra"
When the session is reloaded via GET /chat/history
Then the choice entry has answer:["__other__"] and other_text:"Cassandra"
And the card re-renders with the italic quoted free text
```

### Scenario: Invalid input returns error

```gherkin
Given the AI calls jarvis_ask_choice with neither `question` nor `questions`
Then the tool returns { ok:false, error: /must provide either/ }
And no SSE choice event is broadcast

Given the AI calls jarvis_ask_choice with a `question` but empty `options` array
Then the tool returns { ok:false, error: /must provide either/ }

Given the AI calls jarvis_ask_choice with `questions:[]` (empty array)
Then the tool returns { ok:false, error: /must provide either/ }

Given the AI calls jarvis_ask_choice with `questions:[{question:"", options:[...]}]`
Then the empty-question item is filtered out and, if none remain, error is returned
```

### Scenario: Enter key confirms the card

```gherkin
Given a single-question card with a selection made (any option clicked)
When the user presses Enter (focus anywhere in the card except a textarea)
Then the card submits as if CONFIRM was clicked
And the prompt "[choice] <question> → <label>" is sent to /chat/send

Given the user has selected "Other" and typed text in the textarea
When the user presses Enter inside the textarea (without Shift)
Then the card submits immediately with the free-text answer
```

### Scenario: Multi-question card (NEW)

```gherkin
Given the AI calls jarvis_ask_choice with `questions: [{question:"Q1", options:[...]}, {question:"Q2", options:[...], multi:true}]`
Then ONE SSE event type:"choice" is broadcast with questions[] containing 2 items
And the ChatPanel renders a single card with header "CHOICE · 2 QUESTIONS"
And each question has its own radio/checkbox group separated by a dashed divider
And CONFIRM is disabled until BOTH questions have a valid selection
When the user picks one option for Q1 and checks 2 options for Q2, then presses Enter
Then POST /chat/send is called with a multi-line prompt:
  "[choice]\nQ1 → <label>\nQ2 → <labelA>, <labelB>"
And the card becomes answered with per-question summaries "→ ..." below each group
```

### Scenario: Multi-question persistence survives reload

```gherkin
Given the user completed a 2-question choice
When GET /chat/history?sessionId=main is fetched
Then the choice entry has kind:"choice" with questions[] (2 items) and answers[] (2 items)
And the "[choice]\n..." user message is NOT emitted as a separate entry
```

### Scenario: Session scoping — choice only reaches the caller session

```gherkin
Given two sessions exist: main and actor-alice
When the AI in session "main" calls jarvis_ask_choice
Then only the SSE pool for sessionId="main" receives the type:"choice" event
And the actor-alice SSE pool receives nothing
```

## Execution Checklist

Quick validation sequence — run in order:

```
1. piece_list()
   → Verify: all core pieces listed with correct enabled/running/protected status

2. jarvis_eval — check graph has all pieces:
   jarvis_eval('const gr = (await import("./core/graph-registry.js")).graphRegistry; return JSON.stringify(gr.getTree().map(n => n.id + ":" + n.status))')
   → Verify: jarvis-core + all pieces present with correct status

3. hud_screenshot()
   → Verify: HUD renders with core node graph showing all piece nodes

4. session_info()
   → Verify: main session exists with messageCount > 0

5. "What is 2+2?"
   → Verify: response contains "4", reactor cycles online→processing→online

6. jarvis_eval — reactor status check:
   jarvis_eval('const res = await fetch("http://localhost:50052/hud"); const d = await res.json(); return d.reactor.status')
   → Verify: returns "online"

7. jarvis_eval — SSE idle test:
   jarvis_eval('let count = 0; const res = await fetch("http://localhost:50052/hud-stream"); const reader = res.body.getReader(); const timer = setTimeout(() => reader.cancel(), 5000); try { while(true) { const {done} = await reader.read(); if(done) break; count++; } } catch {} return count')
   → Verify: ≤ 1 delta (only initial snapshot), 0 during idle

8. session_get_tools()
   → Verify: all expected tools registered (bash, read_file, edit_file, glob, grep, etc.)

9. cron_create(cron="once:3s", prompt="[SYSTEM] Cron test fired")
   → Verify: cron_list shows job, message arrives after ~3s, job removed

10. model_get()
    → Verify: returns current model and provider

11. piece_disable("cron") → read settings → piece_enable("cron") → read settings
    → Verify: settings reflect enabled: false then enabled: true

12. hud_layout("grpc", 100, 100, 300, 200) → read settings
    → Verify: settings contain grpc.config.layout with those values
```
