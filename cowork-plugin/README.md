# agent-index-filesystem Cowork Plugin

This plugin connects Cowork sessions to the org's remote filesystem by starting the agent-index MCP server.

## Why This Exists

Cowork does not launch MCP servers defined in `.claude/settings.json`. All MCP servers in Cowork are delivered through its plugin system. This plugin bridges that gap for agent-index — it discovers the workspace at runtime and starts the same MCP server that `.claude/settings.json` starts for Claude Code CLI users.

## How It Works

1. Scans `$HOME/mnt/*/` for a directory containing `agent-index.json`
2. Reads `remote_filesystem.mcp_server.bundle_path` from that config
3. Sets `AIFS_CONFIG_PATH` and starts the server with `node`

The plugin ships no adapter code and no org-specific configuration. It discovers everything from `agent-index.json`, which the bootstrap zip already configures per-org.

## Installation

Members receive this plugin as `agent-index-filesystem.plugin` inside their bootstrap zip. To install: open the `.plugin` file and confirm the install prompt in Cowork.

CLI users do not need this plugin — `.claude/settings.json` handles MCP server startup for them.

## Known Issue: Mid-Session Server Termination

Cowork's platform-level process management can terminate the plugin's MCP server process during active sessions. When this happens, the `aifs_*` tools disappear from the session with no automatic recovery. This is a Cowork platform behavior, not a bug in the plugin or server code — the server has no idle timeouts or self-shutdown logic.

**Fallback:** The bootstrap zip includes `agent-index-core/tools/aifs-bridge/`, an HTTP bridge daemon that spawns the same server bundle as a subprocess outside of Cowork's plugin lifecycle. The session-start task and member-bootstrap skill automatically attempt bridge recovery when native MCP tools are unavailable. Members can also start it manually:

```bash
bash agent-index-core/tools/aifs-bridge/aifs-call.sh --start
```

The bridge provides the same `aifs_*` tools over HTTP (`curl http://127.0.0.1:7819/call`). It auto-restarts the server if the subprocess exits.
