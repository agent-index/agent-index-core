# aifs-bridge — Resilient MCP Server Bridge

## Problem

Cowork's plugin system manages MCP server processes internally and can terminate them mid-session. When this happens, the `aifs_*` tools disappear and there's no way to recover without restarting the entire session. The plugin code and MCP server have no bugs — the process lifecycle is controlled by the platform.

## Solution

`aifs-bridge` is an HTTP daemon that spawns and manages the MCP server as its own child process. If the server dies, the bridge automatically restarts it on the next tool call. Claude interacts with the bridge via `curl` instead of depending on Cowork's MCP tool injection.

## Architecture

```
Claude (bash)  -->  curl POST /call  -->  aifs-bridge (HTTP, port 7819)
                                              |
                                              |  stdio (JSON-RPC)
                                              v
                                         server.bundle.js (MCP server)
                                              |
                                              v
                                         Google Drive / OneDrive / S3
```

The bridge:
- Discovers `agent-index.json` from Cowork mounts (same logic as the plugin), or accepts a direct bundle path
- Spawns the server bundle as a child process
- Completes the MCP initialization handshake
- Forwards tool calls over JSON-RPC on the child's stdio
- Auto-restarts the server if the child process exits
- Exposes health, tool list, restart, and shutdown endpoints

## Integration with session-start and member-bootstrap

The bridge is not something members need to know about. The `session-start` task automatically attempts bridge recovery when it detects that native `aifs_*` MCP tools are missing from the tool list (Step 2). The `member-bootstrap` skill does the same when guiding new members through setup. If the bridge starts successfully, the session proceeds transparently — all `aifs_*` calls route through `localhost:7819` instead of native MCP tools.

## Usage

### Two modes

**Agent-index mode** (default): discovers `agent-index.json` and derives the bundle path from it.

```bash
# Auto-discovers config from Cowork mounts
bash agent-index-core/tools/aifs-bridge/aifs-call.sh --start

# Or with explicit config path
AIFS_CONFIG_PATH=/path/to/agent-index.json bash agent-index-core/tools/aifs-bridge/aifs-call.sh --start
```

**Generic mode**: pass a direct bundle path to bridge any MCP server, not just agent-index.

```bash
node aifs-bridge.mjs --bundle /path/to/any/server.bundle.js --port 7820
node aifs-bridge.mjs --bundle /path/to/server.js --env SOME_VAR=value --env OTHER_VAR=value
```

### Call tools

```bash
# Check auth
bash aifs-call.sh aifs_auth_status

# Read a file
bash aifs-call.sh aifs_read '{"path":"/projects/my-project/status.json"}'

# List a directory
bash aifs-call.sh aifs_list '{"path":"/projects","recursive":false}'

# Write a file
bash aifs-call.sh aifs_write '{"path":"/notes/test.txt","content":"hello"}'
```

### Management

```bash
bash aifs-call.sh --health     # Check bridge + server status
bash aifs-call.sh --tools      # List available aifs tools
bash aifs-call.sh --restart    # Force-restart the MCP server
bash aifs-call.sh --stop       # Shut down the bridge
```

### Auto-start on first call

If the bridge isn't running when you call a tool, `aifs-call.sh` will start it automatically.

## When to use this

Use this bridge when:
- The Cowork plugin's `aifs_*` tools have disappeared mid-session
- You want resilience against the platform killing the MCP server
- You're in a long session doing heavy filesystem work

You don't need this when:
- The plugin tools are working fine
- You're using Claude Code CLI (which manages MCP servers itself via `.claude/settings.json`)

## Port

Default: 7819. Override with `AIFS_BRIDGE_PORT` environment variable or `--port` flag.

## Logs

When started via `aifs-call.sh --start`, logs go to `/tmp/aifs-bridge.log`.
