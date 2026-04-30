# agent-index-filesystem Cowork Plugin

This plugin validates that the agent-index remote filesystem exec bundle is present and accessible in the Cowork session.

## Architecture

Agent-index uses an on-demand execution model for remote filesystem access. Each `aifs_*` operation runs a fresh Node process via the `aifs-exec.sh` shell wrapper, executes one tool call, and exits. There is no persistent server process and no MCP server — Claude calls the shell wrapper directly via bash.

This plugin exists to provide early validation at session start. It discovers the agent-index workspace, verifies the exec bundle is present, and reports any issues. It does not start a server or run any long-lived process.

## How It Works

1. Scans `$HOME/mnt/*/` for a directory containing `agent-index.json`
2. Reads `remote_filesystem.exec.bundle_path` from that config
3. Verifies the exec bundle file exists at the expected location
4. Reports status to stderr for diagnostics

Claude accesses the remote filesystem by calling the shell wrapper directly:

```bash
bash <project_dir>/mcp-servers/filesystem/aifs-exec.sh aifs_read '{"path":"/projects/foo/project.md"}'
```

## Installation

Members receive this plugin as `agent-index-filesystem.plugin` inside their bootstrap zip. To install: open the `.plugin` file and confirm the install prompt in Cowork.

CLI users do not need this plugin — the session-bootstrap hook and session-start task handle everything.

## Previous Architecture (Removed)

Earlier versions used a persistent MCP server process that Cowork would start via this plugin, with an HTTP bridge daemon as a fallback when the server was terminated mid-session. This architecture was removed because Cowork's platform-level process management would terminate the server unpredictably, the bridge added complexity and its own failure modes, and the on-demand executor proved more reliable with comparable performance when path caching is warm.
