# agent-index-show-plan installers

One-shot per-user installation scripts. None require admin/root.

Each script lays the binary in a stable per-user location, runs the binary's `--register` flag to wire up the `agent-index://` URL scheme, then verifies. Re-running an installer overwrites the previous install (idempotent).

## Windows

```powershell
# From the directory containing both install.ps1 and agent-index-show-plan.exe:
pwsh -File install.ps1
```

Installs to `%LOCALAPPDATA%\Agent-Index\bin\agent-index-show-plan.exe` and writes registry keys under `HKCU\Software\Classes\agent-index`.

To uninstall:

```powershell
pwsh -File uninstall.ps1
```

## macOS

```bash
bash install.sh
```

Builds a minimal `.app` bundle at `~/Applications/Agent-Index Helper.app/` whose `Info.plist` declares the `agent-index://` URL scheme, places the binary inside, and asks LaunchServices to register it.

To uninstall:

```bash
bash uninstall.sh
```

## Linux

```bash
bash install.sh
```

Lays the binary at `~/.local/bin/`, writes `~/.local/share/applications/agent-index-show-plan.desktop`, and runs `xdg-mime` to bind the scheme.

Requires `xdg-utils` to be installed. The script will check and tell you the right package-manager command if it's missing.

To uninstall:

```bash
bash uninstall.sh
```

## Verifying the install

After installation, the binary is callable via the URL scheme. From any shell:

| Platform | Command |
|---|---|
| Windows | `start "" "agent-index://apply?spec=outputs/some-spec.json"` |
| macOS   | `open "agent-index://apply?spec=outputs/some-spec.json"` |
| Linux   | `xdg-open "agent-index://apply?spec=outputs/some-spec.json"` |

Or click any `agent-index://` link in chat — the OS routes it to the binary.

## Spec path resolution

URLs are interpreted as `agent-index://apply?spec=<path>` where `<path>` is **relative to the workspace root** (the directory containing `agent-index.json`). The binary refuses paths that resolve outside `<workspace>/outputs/`.
