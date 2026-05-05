// Package listener provides the ephemeral one-shot HTTP listener and
// the lifecycle state machine for the permission helper.
//
// State diagram (mirrored from the Node helper's lifecycle.js):
//
//   WAITING          → APPLYING (on /apply) | REJECTED (on /reject)
//                    | DISCONNECTED (heartbeat gap >15s) | TIMED_OUT (idle 10min)
//                    | TERMINATED (signal)
//
//   APPLYING         → DONE (apply exit 0) | ERROR_AWAITING_USER (apply exit 1|2)
//                    | ERROR_INTERNAL (apply exit 3) | TERMINATED (signal)
//
//   DONE             → exit(0) after post-completion window or page close
//
//   ERROR_AWAITING_USER → APPLYING (on /retry) | exit(3) (on /reject or page close)
//                       | TIMED_OUT | TERMINATED
package listener

import (
	"sync"
	"time"
)

type State string

const (
	StateWaiting           State = "WAITING"
	StateApplying          State = "APPLYING"
	StateDone              State = "DONE"
	StateRejected          State = "REJECTED"
	StateTimedOut          State = "TIMED_OUT"
	StateDisconnected      State = "DISCONNECTED"
	StateTerminated        State = "TERMINATED"
	StateErrorAwaitingUser State = "ERROR_AWAITING_USER"
	StateErrorInternal     State = "ERROR_INTERNAL"
)

// Exit codes — keep in sync with the Node helper's EXIT_CODES.
const (
	ExitApplied         = 0
	ExitRejected        = 1
	ExitTimedOut        = 2
	ExitApplyFailed     = 3
	ExitPageClosed      = 4
	ExitValidationError = 5
	ExitSIGINT          = 130
	ExitSIGTERM         = 143
)

// Default timing (mirrored from the Node helper's DEFAULTS).
type Timing struct {
	IdleTimeoutMs              int
	HeartbeatGapMs             int
	HeartbeatExpectedIntervalMs int
	PostCompletionWindowMs     int
	ApplyScriptHardTimeoutMs   int
}

func DefaultTiming() Timing {
	return Timing{
		IdleTimeoutMs:               10 * 60 * 1000,
		HeartbeatGapMs:              15 * 1000,
		HeartbeatExpectedIntervalMs: 5 * 1000,
		PostCompletionWindowMs:      30 * 1000,
		ApplyScriptHardTimeoutMs:    5 * 60 * 1000,
	}
}

// StatusReport is the final JSON the binary writes to stdout when it exits.
// Same shape as the Node helper's emitFinal().
type StatusReport struct {
	Outcome           string        `json:"outcome"`
	AppliedOperations []int         `json:"applied_operations"`
	FailedOperations  []FailedOp    `json:"failed_operations"`
	VerifiedPostState []VerifiedRow `json:"verified_post_state"`
	UserEdits         interface{}   `json:"user_edits"`
	ErrorDetail       string        `json:"error_detail,omitempty"`
}

type FailedOp struct {
	OpIndex int        `json:"op_index"`
	Error   ErrorBlock `json:"error"`
}

type ErrorBlock struct {
	Code    string `json:"code"`
	Message string `json:"message,omitempty"`
}

type VerifiedRow struct {
	OpIndex    int                  `json:"op_index"`
	Resource   string               `json:"resource"`
	Recipients []map[string]string  `json:"recipients"`
}

// Terminal is the data passed to the OnTerminal callback.
type Terminal struct {
	State        State
	ExitCode     int
	StatusReport StatusReport
}

// Lifecycle is the state machine. Created with NewLifecycle, fed events
// via the OnX methods, and produces a single Terminal call when one of
// the terminal conditions is reached.
type Lifecycle struct {
	mu             sync.Mutex
	state          State
	timing         Timing
	lastHeartbeat  time.Time
	statusReport   StatusReport
	terminated     bool
	timers         lifecycleTimers
	onTerminal     func(Terminal)
}

type lifecycleTimers struct {
	idle           *time.Timer
	heartbeat      *time.Ticker
	stopHeartbeat  chan struct{}
	postCompletion *time.Timer
	applyHard      *time.Timer
}

// NewLifecycle constructs a Lifecycle in StateWaiting and starts the
// idle timer + heartbeat watcher.
func NewLifecycle(onTerminal func(Terminal), timing Timing) *Lifecycle {
	if onTerminal == nil {
		panic("listener: NewLifecycle requires onTerminal callback")
	}
	lc := &Lifecycle{
		state:         StateWaiting,
		timing:        timing,
		lastHeartbeat: time.Now(),
		onTerminal:    onTerminal,
	}
	lc.statusReport.AppliedOperations = []int{}
	lc.statusReport.FailedOperations = []FailedOp{}
	lc.statusReport.VerifiedPostState = []VerifiedRow{}
	lc.startIdleTimer()
	lc.startHeartbeatWatcher()
	return lc
}

// State returns the current state. Useful for tests and HTTP gating.
func (lc *Lifecycle) State() State {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	return lc.state
}

// OnApply transitions to APPLYING. Returns false if not in a state that
// can begin applying.
func (lc *Lifecycle) OnApply() bool {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	if lc.state != StateWaiting && lc.state != StateErrorAwaitingUser {
		return false
	}
	lc.state = StateApplying
	lc.clearTimers()
	lc.startApplyHardTimeout()
	return true
}

// OnReject terminates with REJECTED.
func (lc *Lifecycle) OnReject() bool {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	if lc.state == StateWaiting {
		lc.statusReport.Outcome = "rejected"
		lc.terminate(StateRejected, ExitRejected)
		return true
	}
	if lc.state == StateErrorAwaitingUser {
		lc.statusReport.Outcome = "apply_error"
		lc.statusReport.ErrorDetail = "user closed without retry after partial failure"
		lc.terminate(StateRejected, ExitApplyFailed)
		return true
	}
	return false
}

// OnRetry transitions ERROR_AWAITING_USER back to APPLYING.
func (lc *Lifecycle) OnRetry() bool {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	if lc.state != StateErrorAwaitingUser {
		return false
	}
	lc.state = StateApplying
	lc.clearTimers()
	lc.startApplyHardTimeout()
	return true
}

// OnHeartbeat resets the page-disconnect watchdog.
func (lc *Lifecycle) OnHeartbeat() {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	lc.lastHeartbeat = time.Now()
}

// OnApplyScriptExit reports the apply-script's exit code and final report.
func (lc *Lifecycle) OnApplyScriptExit(exitCode int, applyResult *StatusReport) bool {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	if lc.state != StateApplying {
		return false
	}
	lc.clearTimers()

	if applyResult != nil {
		lc.statusReport.AppliedOperations = applyResult.AppliedOperations
		lc.statusReport.FailedOperations = applyResult.FailedOperations
		lc.statusReport.VerifiedPostState = applyResult.VerifiedPostState
	}

	switch exitCode {
	case 0:
		lc.state = StateDone
		lc.statusReport.Outcome = "applied"
		lc.startPostCompletionWindow()
	case 1:
		lc.state = StateErrorAwaitingUser
		lc.statusReport.Outcome = "partial_failure"
		lc.startIdleTimer()
		lc.startHeartbeatWatcher()
	case 2:
		lc.state = StateErrorAwaitingUser
		lc.statusReport.Outcome = "apply_error"
		lc.startIdleTimer()
		lc.startHeartbeatWatcher()
	default:
		lc.statusReport.Outcome = "apply_error"
		lc.statusReport.ErrorDetail = "apply-script exited with unexpected code"
		lc.terminate(StateErrorInternal, ExitApplyFailed)
	}
	return true
}

// OnSignal handles SIGINT/SIGTERM.
func (lc *Lifecycle) OnSignal(sig string) {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	exitCode := ExitSIGTERM
	if sig == "SIGINT" {
		exitCode = ExitSIGINT
	}
	lc.statusReport.Outcome = "terminated"
	lc.terminate(StateTerminated, exitCode)
}

// OnPageClose handles a heartbeat gap or beforeunload beacon.
func (lc *Lifecycle) OnPageClose() {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	switch lc.state {
	case StateWaiting:
		lc.statusReport.Outcome = "page_closed"
		lc.terminate(StateDisconnected, ExitPageClosed)
	case StateErrorAwaitingUser:
		lc.statusReport.Outcome = "apply_error"
		lc.terminate(StateDisconnected, ExitApplyFailed)
	case StateDone:
		// User saw success and closed the page. Exit cleanly.
		lc.terminate(StateDone, ExitApplied)
	}
	// In APPLYING: do NOT cancel — let the apply-script run to completion.
}

// HeartbeatGapExceeded checks whether the page is silent for too long.
// Called periodically by the heartbeat watcher goroutine.
func (lc *Lifecycle) HeartbeatGapExceeded() bool {
	lc.mu.Lock()
	defer lc.mu.Unlock()
	gap := time.Since(lc.lastHeartbeat)
	return gap > time.Duration(lc.timing.HeartbeatGapMs)*time.Millisecond
}

// terminate is internal — caller must hold lc.mu.
func (lc *Lifecycle) terminate(state State, exitCode int) {
	if lc.terminated {
		return
	}
	lc.terminated = true
	lc.state = state
	lc.clearTimers()
	cb := lc.onTerminal
	report := lc.statusReport
	// Release the lock before invoking the callback to avoid deadlocks
	// if the callback tries to call back into Lifecycle methods.
	go cb(Terminal{State: state, ExitCode: exitCode, StatusReport: report})
}

// startIdleTimer — caller must hold lc.mu.
func (lc *Lifecycle) startIdleTimer() {
	if lc.timers.idle != nil {
		lc.timers.idle.Stop()
	}
	lc.timers.idle = time.AfterFunc(time.Duration(lc.timing.IdleTimeoutMs)*time.Millisecond, func() {
		lc.mu.Lock()
		defer lc.mu.Unlock()
		if lc.terminated {
			return
		}
		lc.statusReport.Outcome = "timed_out"
		lc.terminate(StateTimedOut, ExitTimedOut)
	})
}

// startHeartbeatWatcher — caller must hold lc.mu.
func (lc *Lifecycle) startHeartbeatWatcher() {
	if lc.timers.stopHeartbeat != nil {
		close(lc.timers.stopHeartbeat)
	}
	stop := make(chan struct{})
	lc.timers.stopHeartbeat = stop
	checkInterval := time.Duration(lc.timing.HeartbeatExpectedIntervalMs/2) * time.Millisecond
	lc.timers.heartbeat = time.NewTicker(checkInterval)
	go func() {
		ticker := lc.timers.heartbeat
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				return
			case <-ticker.C:
				if lc.HeartbeatGapExceeded() {
					lc.OnPageClose()
					return
				}
			}
		}
	}()
}

// startPostCompletionWindow — caller must hold lc.mu.
func (lc *Lifecycle) startPostCompletionWindow() {
	if lc.timers.postCompletion != nil {
		lc.timers.postCompletion.Stop()
	}
	lc.timers.postCompletion = time.AfterFunc(time.Duration(lc.timing.PostCompletionWindowMs)*time.Millisecond, func() {
		lc.mu.Lock()
		defer lc.mu.Unlock()
		if lc.terminated {
			return
		}
		lc.terminate(StateDone, ExitApplied)
	})
}

// startApplyHardTimeout — caller must hold lc.mu.
func (lc *Lifecycle) startApplyHardTimeout() {
	if lc.timers.applyHard != nil {
		lc.timers.applyHard.Stop()
	}
	lc.timers.applyHard = time.AfterFunc(time.Duration(lc.timing.ApplyScriptHardTimeoutMs)*time.Millisecond, func() {
		lc.mu.Lock()
		defer lc.mu.Unlock()
		if lc.terminated {
			return
		}
		lc.statusReport.Outcome = "apply_error"
		lc.statusReport.ErrorDetail = "apply-script hard timeout exceeded"
		lc.terminate(StateErrorInternal, ExitApplyFailed)
	})
}

// clearTimers — caller must hold lc.mu.
func (lc *Lifecycle) clearTimers() {
	if lc.timers.idle != nil {
		lc.timers.idle.Stop()
		lc.timers.idle = nil
	}
	if lc.timers.postCompletion != nil {
		lc.timers.postCompletion.Stop()
		lc.timers.postCompletion = nil
	}
	if lc.timers.applyHard != nil {
		lc.timers.applyHard.Stop()
		lc.timers.applyHard = nil
	}
	if lc.timers.stopHeartbeat != nil {
		close(lc.timers.stopHeartbeat)
		lc.timers.stopHeartbeat = nil
	}
}
