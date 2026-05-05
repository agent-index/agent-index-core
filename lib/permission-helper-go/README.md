# permission-helper-go (spike)

Go rewrite of the Node-based permission-helper. Implements idea
`permission-helper-portable-runtime-and-url-handler` and tech design
`permission-helper-go-rewrite-tech-design`.

## Status: spike

This is the v0.1 spike. What's in:

- ✅ Spec types + validator (`internal/spec/`)
- ✅ Lifecycle state machine, all 9 states (`internal/listener/lifecycle.go`)
- ✅ HTTP listener + SSE + 6 endpoints, token + origin auth (`internal/listener/server.go`)
- ✅ Page renderer, embedded `templates/page.html` (`internal/render/`)
- ✅ Cross-platform browser launcher (`internal/browser/`)
- ✅ URL parser for `agent-index://` (`internal/urlhandler/`)
- ✅ Main entry point with `--cli` fallback, URL-handler form, `--register` stub (`cmd/agent-index-show-plan/`)
- ✅ goreleaser config for per-platform binaries (`.goreleaser.yaml`)

What's done:

- ✅ Drive API integration in `internal/apply/drive.go` — real `google.golang.org/api/drive/v3` client with share/unshare/transfer_ownership ops, path resolution (cache + tree walk), and post-state verification.
- ✅ OAuth token discovery in `internal/auth/token.go` — reads `agent-index.json` for the OAuth client config, loads tokens from the gdrive adapter's `gdrive.json` stash, and persists refreshed tokens back atomically.
- ✅ Stub mode via `--stub` flag — runs against `apply.StubDriver` for testing/demos without auth.

What's pending:

- 🚧 URL-scheme registration per platform (`internal/urlhandler/register_*.go` not yet written) — `--register` flag prints a TODO and exits.
- 🚧 Per-platform installer packaging (`installer/{windows,darwin,linux}/`).

## Build (when Go is installed locally)

```bash
cd lib/permission-helper-go
go mod tidy
go build -o agent-index-show-plan ./cmd/agent-index-show-plan
./agent-index-show-plan --version
```

For a cross-platform release build (after `goreleaser` is installed):

```bash
goreleaser build --snapshot --clean
ls dist/
```

## Run the spike

The spike has no real Drive integration, so it's safe to run against
any spec. The apply step returns canned successes (or canned failures
if `AIFS_HELPER_STUB_FAIL=1` is set).

```bash
# CLI mode (no browser):
./agent-index-show-plan path/to/spec.json --cli

# Interactive mode (opens browser):
./agent-index-show-plan path/to/spec.json
```

Final outcome JSON is on the last line of stdout.

## Architecture

See:
- Decision record: `/shared/projects/access-control/decisions/permission-change-via-plan-page.md`
- Idea: `permission-helper-portable-runtime-and-url-handler`
- Tech design: `/shared/projects/access-control/artifacts/permission-helper-go-rewrite-tech-design.md`
- Standards: `agent-index-core/standards.md` § "Permission-Modifying Operations"

## Compared to the Node helper

Functional parity (same spec format, same wire protocol, same lifecycle states, same exit codes, same final JSON shape). The Node helper at `lib/permission-helper/` stays in place for the 3.3.x compatibility window; the Go rewrite ships in 3.4.0 once it's verified end-to-end.
