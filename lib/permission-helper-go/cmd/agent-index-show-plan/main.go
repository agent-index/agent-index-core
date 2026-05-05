// agent-index-show-plan — Permission-change helper main binary.
//
// Invocation forms:
//   agent-index-show-plan <spec-path>             # interactive, opens browser
//   agent-index-show-plan <spec-path> --cli       # headless, terminal y/N
//   agent-index-show-plan agent-index://apply?spec=<path>  # URL-handler form
//   agent-index-show-plan --register              # register URL scheme handler
//   agent-index-show-plan --unregister            # unregister
//   agent-index-show-plan --version
//
// On exit, writes a single-line JSON status report to stdout.
package main

import (
	"bufio"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/apply"
	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/auth"
	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/browser"
	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/listener"
	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/render"
	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/spec"
	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/urlhandler"
)

var Version = "0.1.0-spike" // set at build time via -ldflags

func diag(format string, args ...interface{}) {
	fmt.Fprintf(os.Stderr, "[helper] "+format+"\n", args...)
}

func emitFinal(report listener.StatusReport) {
	data, _ := json.Marshal(report)
	fmt.Fprintln(os.Stdout, string(data))
}

func main() {
	args := os.Args[1:]
	if len(args) == 0 {
		usage()
		os.Exit(listener.ExitValidationError)
	}

	// Detect URL-handler invocation: argv[1] is an agent-index:// URL.
	if urlhandler.IsURL(args[0]) {
		runFromURL(args[0])
		return
	}

	// Detect flags.
	var (
		cli          bool
		stub         bool
		validateOnly bool
		register     bool
		unregister   bool
		showVersion  bool
		specPath     string
	)
	for _, a := range args {
		switch a {
		case "--cli":
			cli = true
		case "--stub":
			stub = true
		case "--validate-only":
			validateOnly = true
		case "--register":
			register = true
		case "--unregister":
			unregister = true
		case "--version", "-v":
			showVersion = true
		default:
			if !strings.HasPrefix(a, "--") {
				specPath = a
			}
		}
	}

	if showVersion {
		fmt.Println(Version)
		return
	}
	if register {
		if err := urlhandler.Register(); err != nil {
			diag("registration failed: %v", err)
			os.Exit(listener.ExitValidationError)
		}
		ok, _ := urlhandler.IsRegistered()
		if ok {
			diag("agent-index:// scheme registered for the current user.")
		} else {
			diag("agent-index:// scheme registration completed but verification was inconclusive.")
		}
		os.Exit(0)
	}
	if unregister {
		if err := urlhandler.Unregister(); err != nil {
			diag("unregistration failed: %v", err)
			os.Exit(listener.ExitValidationError)
		}
		diag("agent-index:// scheme unregistered.")
		os.Exit(0)
	}
	if specPath == "" {
		usage()
		os.Exit(listener.ExitValidationError)
	}

	if validateOnly {
		runValidateOnly(specPath)
		return
	}

	runFromSpec(specPath, cli, stub)
}

// runValidateOnly reads + parses + validates the spec, prints the result,
// and exits. No prompts, no Drive calls, no listener. For CI / dev use.
func runValidateOnly(specPath string) {
	bytes, err := os.ReadFile(specPath)
	if err != nil {
		diag("could not read spec at %s: %v", specPath, err)
		os.Exit(listener.ExitValidationError)
	}
	var s spec.Spec
	if err := json.Unmarshal(bytes, &s); err != nil {
		diag("could not parse spec: %v", err)
		os.Exit(listener.ExitValidationError)
	}
	v := spec.Validate(&s)
	if !v.OK {
		diag("validation: failed")
		for _, e := range v.Errors {
			diag("  - %s", e)
		}
		os.Exit(listener.ExitValidationError)
	}
	fmt.Fprintln(os.Stderr, "validation: ok")
	fmt.Fprintf(os.Stderr, "operations: %d\n", len(s.Operations))
	os.Exit(0)
}

func usage() {
	diag("Usage:")
	diag("  agent-index-show-plan <spec-path>             # interactive")
	diag("  agent-index-show-plan <spec-path> --cli       # headless terminal mode")
	diag("  agent-index-show-plan <spec-path> --stub      # no-op driver (no Drive calls)")
	diag("  agent-index-show-plan <spec-path> --validate-only  # validate spec, print result, exit")
	diag("  agent-index-show-plan agent-index://apply?spec=<path>")
	diag("  agent-index-show-plan --register              # register URL scheme")
	diag("  agent-index-show-plan --unregister            # unregister URL scheme")
	diag("  agent-index-show-plan --version")
}

func runFromURL(rawURL string) {
	workspace, err := workspaceRoot()
	if err != nil {
		diag("could not determine workspace root: %v", err)
		emitFinal(listener.StatusReport{Outcome: "validation_error", ErrorDetail: err.Error()})
		os.Exit(listener.ExitValidationError)
	}
	parsed, err := urlhandler.Parse(rawURL, workspace)
	if err != nil {
		diag("invalid URL: %v", err)
		emitFinal(listener.StatusReport{Outcome: "validation_error", ErrorDetail: err.Error()})
		os.Exit(listener.ExitValidationError)
	}
	runFromSpec(parsed.SpecPath, false, false)
}

func runFromSpec(specPath string, cli, stub bool) {
	bytes, err := os.ReadFile(specPath)
	if err != nil {
		diag("could not read spec at %s: %v", specPath, err)
		emitFinal(listener.StatusReport{Outcome: "validation_error", ErrorDetail: err.Error()})
		os.Exit(listener.ExitValidationError)
	}
	var s spec.Spec
	if err := json.Unmarshal(bytes, &s); err != nil {
		diag("could not parse spec: %v", err)
		emitFinal(listener.StatusReport{Outcome: "validation_error", ErrorDetail: err.Error()})
		os.Exit(listener.ExitValidationError)
	}
	v := spec.Validate(&s)
	if !v.OK {
		diag("spec validation failed:")
		for _, e := range v.Errors {
			diag("  - %s", e)
		}
		emitFinal(listener.StatusReport{Outcome: "validation_error", ErrorDetail: strings.Join(v.Errors, "; ")})
		os.Exit(listener.ExitValidationError)
	}

	drv, err := buildDriver(stub)
	if err != nil {
		diag("could not construct Drive driver: %v", err)
		emitFinal(listener.StatusReport{Outcome: "validation_error", ErrorDetail: err.Error()})
		os.Exit(listener.ExitValidationError)
	}

	if cli {
		runCli(&s, drv)
		return
	}
	runInteractive(&s, drv)
}

// buildDriver returns a Drive driver. Stub mode returns a no-op driver
// useful for testing and the early spike. Real mode constructs an
// authenticated Drive client from the workspace's gdrive credentials.
func buildDriver(stub bool) (apply.Driver, error) {
	if stub {
		return apply.StubDriver{}, nil
	}
	workspace, err := workspaceRoot()
	if err != nil {
		return nil, err
	}
	ctx := context.Background()
	ts, err := auth.NewTokenSource(ctx, workspace)
	if err != nil {
		return nil, fmt.Errorf("load OAuth token: %w", err)
	}
	return apply.NewDriveDriver(ctx, workspace, ts)
}

func runCli(s *spec.Spec, drv apply.Driver) {
	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, summarizeForCli(s))
	fmt.Fprintln(os.Stderr)
	fmt.Fprint(os.Stderr, "Apply these changes? [y/N] ")
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Scan()
	answer := strings.TrimSpace(scanner.Text())
	if !strings.EqualFold(answer, "y") && !strings.EqualFold(answer, "yes") {
		emitFinal(listener.StatusReport{
			Outcome:           "rejected",
			AppliedOperations: []int{},
			FailedOperations:  []listener.FailedOp{},
		})
		os.Exit(listener.ExitRejected)
	}

	emitter := stderrEmitter{}
	report := apply.Apply(s, emitter, drv)
	emitFinal(report)
	if len(report.FailedOperations) == 0 {
		os.Exit(listener.ExitApplied)
	}
	os.Exit(listener.ExitApplyFailed)
}

func runInteractive(s *spec.Spec, drv apply.Driver) {
	token, err := newToken()
	if err != nil {
		diag("could not generate token: %v", err)
		os.Exit(listener.ExitValidationError)
	}

	terminalCh := make(chan listener.Terminal, 1)
	lc := listener.NewLifecycle(func(t listener.Terminal) {
		terminalCh <- t
	}, listener.DefaultTiming())

	srv := &listener.Server{
		Spec:      s,
		Token:     token,
		Lifecycle: lc,
		Render:    render.Render,
	}
	srv.OnApply = func(submitted *spec.Spec) {
		emitter := sseEmitter{srv: srv}
		report := apply.Apply(submitted, emitter, drv)
		// Map the apply outcome to a lifecycle exit code.
		var exitCode int
		switch report.Outcome {
		case "applied":
			exitCode = 0
		case "partial_failure":
			exitCode = 1
		case "apply_error":
			exitCode = 2
		default:
			exitCode = 3
		}
		// Emit a "done" event so the page can render the final state.
		srv.Broadcast(map[string]interface{}{
			"type":                "done",
			"successful":          report.AppliedOperations,
			"failed":              report.FailedOperations,
			"verified_post_state": report.VerifiedPostState,
		})
		lc.OnApplyScriptExit(exitCode, &report)
	}

	port, err := srv.Start()
	if err != nil {
		diag("could not bind to localhost: %v. Try --cli.", err)
		emitFinal(listener.StatusReport{Outcome: "validation_error", ErrorDetail: "bind failed: " + err.Error()})
		os.Exit(listener.ExitValidationError)
	}
	defer srv.Shutdown()
	_ = port

	// Wire up signal handlers.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		sig := <-sigCh
		switch sig {
		case syscall.SIGINT:
			lc.OnSignal("SIGINT")
		case syscall.SIGTERM:
			lc.OnSignal("SIGTERM")
		}
	}()

	// Open the browser. If it fails, surface the URL.
	url := srv.URL()
	if err := browser.Open(url); err != nil {
		diag("could not open browser automatically.")
		diag("Open this URL in your browser to review:")
		diag("  %s", url)
		diag("The listener is waiting for up to 10 minutes.")
	} else {
		diag("Opened review page: %s", url)
	}

	// Wait for terminal.
	t := <-terminalCh
	emitFinal(t.StatusReport)

	// 200ms grace so any in-flight HTTP response has time to drain to the
	// client before we exit. Belt-and-suspenders fallback for /reject's
	// internal grace.
	time.Sleep(200 * time.Millisecond)
	os.Exit(t.ExitCode)
}

// summarizeForCli mirrors the Node helper's summarizeForCli output verbatim.
func summarizeForCli(s *spec.Spec) string {
	var b strings.Builder
	fmt.Fprintln(&b, "agent-index — permission change")
	fmt.Fprintln(&b)
	fmt.Fprintf(&b, "Purpose: %s\n", s.Context.Purpose)
	fmt.Fprintf(&b, "Requested by: %s\n", s.Context.Requestor)
	if s.Context.CallingTask != "" {
		fmt.Fprintf(&b, "From task: %s\n", s.Context.CallingTask)
	}
	fmt.Fprintln(&b)
	plural := "s"
	if len(s.Operations) == 1 {
		plural = ""
	}
	fmt.Fprintf(&b, "%d operation%s:\n", len(s.Operations), plural)
	for i, op := range s.Operations {
		role := ""
		if op.Role != "" {
			role = " (" + op.Role + ")"
		}
		fmt.Fprintf(&b, "  %d. %s  %s  →  %s%s\n", i+1, op.Op, op.Resource, op.Recipient, role)
	}
	return b.String()
}

// newToken generates a UUID-shaped token for the session.
func newToken() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	// Set version 4 and variant 10 bits per RFC 4122.
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%s-%s-%s-%s-%s",
		hex.EncodeToString(b[0:4]),
		hex.EncodeToString(b[4:6]),
		hex.EncodeToString(b[6:8]),
		hex.EncodeToString(b[8:10]),
		hex.EncodeToString(b[10:16])), nil
}

// workspaceRoot finds the workspace folder. Looks for AGENT_INDEX_WORKSPACE
// env var; falls back to walking up from the binary's location for an
// agent-index.json.
//
// Discriminator: collections ship their own template `agent-index.json`
// alongside a `collection.json`. The workspace's marker has no
// `collection.json` sibling. We skip any match that has one.
func workspaceRoot() (string, error) {
	if env := os.Getenv("AGENT_INDEX_WORKSPACE"); env != "" {
		return env, nil
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 8; i++ {
		marker := filepath.Join(dir, "agent-index.json")
		if _, err := os.Stat(marker); err == nil {
			collectionMarker := filepath.Join(dir, "collection.json")
			if _, err := os.Stat(collectionMarker); err != nil {
				// agent-index.json present, collection.json absent → workspace root.
				return dir, nil
			}
			// Collection template — keep walking up.
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("could not find workspace root (no agent-index.json without sibling collection.json found walking up from %s)", filepath.Dir(exe))
}

// --- Event emitters ---

type stderrEmitter struct{}

func (stderrEmitter) OpPending(opIndex int, op spec.Op) {
	fmt.Fprintf(os.Stderr, "  · op_%d\n", opIndex)
}
func (stderrEmitter) OpComplete(opIndex int, _ []spec.Recipient) {
	fmt.Fprintf(os.Stderr, "  ✓ op_%d\n", opIndex)
}
func (stderrEmitter) OpFailed(opIndex int, code, message string) {
	if message == "" {
		fmt.Fprintf(os.Stderr, "  ✗ op_%d: %s\n", opIndex, code)
	} else {
		fmt.Fprintf(os.Stderr, "  ✗ op_%d: %s\n", opIndex, message)
	}
}

type sseEmitter struct {
	srv *listener.Server
}

func (e sseEmitter) OpPending(opIndex int, op spec.Op) {
	e.srv.Broadcast(map[string]interface{}{
		"type":      "op_pending",
		"op_index":  opIndex,
		"op":        op.Op,
		"resource":  op.Resource,
		"recipient": op.Recipient,
		"role":      op.Role,
	})
}
func (e sseEmitter) OpComplete(opIndex int, recipients []spec.Recipient) {
	e.srv.Broadcast(map[string]interface{}{
		"type":           "op_complete",
		"op_index":       opIndex,
		"verified_state": map[string]interface{}{"recipients": recipients},
	})
}
func (e sseEmitter) OpFailed(opIndex int, code, message string) {
	e.srv.Broadcast(map[string]interface{}{
		"type":     "op_failed",
		"op_index": opIndex,
		"error":    map[string]string{"code": code, "message": message},
	})
}
