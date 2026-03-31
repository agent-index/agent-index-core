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
