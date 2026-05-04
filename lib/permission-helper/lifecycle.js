// lifecycle.js — Listener state machine for the permission helper.
//
// State diagram (from tech design):
//
//   WAITING (idle ≤ 10 min, heartbeats present)
//     → /apply received     → APPLYING
//     → /reject received    → REJECTED → exit(1)
//     → heartbeat absent    → DISCONNECTED → exit(4)
//     → idle ≥ 10 min       → TIMED_OUT → exit(2)
//     → SIGINT/SIGTERM      → TERMINATED → exit(130|143)
//
//   APPLYING (apply-script running)
//     → apply-script exits 0       → DONE
//     → apply-script exits 1|2     → ERROR_AWAITING_USER
//     → apply-script exits 3       → ERROR_INTERNAL → exit(3)
//     → SIGINT/SIGTERM             → TERMINATED → exit(130|143)
//
//   DONE (apply complete, post-completion window 30s)
//     → window expires             → exit(0)
//     → page closed                → exit(0)
//     → SIGINT/SIGTERM             → exit(130|143)
//
//   ERROR_AWAITING_USER (partial/total failure, user can retry)
//     → /retry received            → APPLYING (with reduced spec)
//     → /reject received           → exit(3)
//     → heartbeat absent ≥ 15s     → exit(3)
//     → idle ≥ 10 min              → exit(2)
//     → SIGINT/SIGTERM             → exit(130|143)

'use strict';

const STATES = Object.freeze({
  WAITING: 'WAITING',
  APPLYING: 'APPLYING',
  DONE: 'DONE',
  REJECTED: 'REJECTED',
  TIMED_OUT: 'TIMED_OUT',
  DISCONNECTED: 'DISCONNECTED',
  TERMINATED: 'TERMINATED',
  ERROR_AWAITING_USER: 'ERROR_AWAITING_USER',
  ERROR_INTERNAL: 'ERROR_INTERNAL',
});

const EXIT_CODES = Object.freeze({
  APPLIED: 0,
  REJECTED: 1,
  TIMED_OUT: 2,
  APPLY_FAILED: 3,
  PAGE_CLOSED: 4,
  VALIDATION_ERROR: 5,
  SIGINT: 130,
  SIGTERM: 143,
});

const DEFAULTS = Object.freeze({
  idleTimeoutMs: 10 * 60 * 1000,           // 10 min
  heartbeatGapMs: 15 * 1000,                // 15 sec
  heartbeatExpectedIntervalMs: 5 * 1000,    // page sends every 5s
  postCompletionWindowMs: 30 * 1000,        // 30 sec after DONE
  applyScriptHardTimeoutMs: 5 * 60 * 1000,  // 5 min — kill apply-script if no exit by then
});

class Lifecycle {
  /**
   * @param {object}   options
   * @param {function} options.onTerminal  Callback invoked when a terminal state is reached.
   *                                        Receives ({state, exitCode, statusReport}).
   * @param {object}   [options.timing]    Override default timeouts (used in tests).
   */
  constructor({ onTerminal, timing = {} }) {
    if (typeof onTerminal !== 'function') {
      throw new TypeError('Lifecycle requires onTerminal callback');
    }
    this.onTerminal = onTerminal;
    this.timing = { ...DEFAULTS, ...timing };
    this.state = STATES.WAITING;
    this.lastHeartbeat = Date.now();
    this.statusReport = {
      outcome: null,
      applied_operations: [],
      failed_operations: [],
      verified_post_state: [],
      user_edits: null,
      error_detail: null,
    };
    this._timers = {};
    this._terminated = false;
    this._startIdleTimer();
    this._startHeartbeatWatcher();
  }

  // ---- Public transitions (called by the listener on incoming events) ----

  onApply(spec) {
    if (this.state !== STATES.WAITING && this.state !== STATES.ERROR_AWAITING_USER) {
      return false;
    }
    this._setState(STATES.APPLYING);
    this._clearTimers();
    this._startApplyHardTimeout();
    this.statusReport.user_edits = this._captureUserEdits(spec);
    return true;
  }

  onReject() {
    if (this.state === STATES.WAITING) {
      this._terminate(STATES.REJECTED, EXIT_CODES.REJECTED, { outcome: 'rejected' });
      return true;
    }
    if (this.state === STATES.ERROR_AWAITING_USER) {
      this._terminate(STATES.REJECTED, EXIT_CODES.APPLY_FAILED, { outcome: 'apply_error', error_detail: 'user closed without retry after partial failure' });
      return true;
    }
    return false;
  }

  onRetry(spec) {
    if (this.state !== STATES.ERROR_AWAITING_USER) return false;
    this._setState(STATES.APPLYING);
    this._clearTimers();
    this._startApplyHardTimeout();
    this.statusReport.user_edits = this._captureUserEdits(spec);
    return true;
  }

  onHeartbeat() {
    this.lastHeartbeat = Date.now();
    return true;
  }

  onApplyScriptExit(exitCode, applyResult) {
    if (this.state !== STATES.APPLYING) return false;
    this._clearTimers();

    // applyResult is the parsed `done` line from apply-script stdout.
    if (applyResult) {
      this.statusReport.applied_operations = applyResult.successful || [];
      this.statusReport.failed_operations = applyResult.failed || [];
      this.statusReport.verified_post_state = applyResult.verified_post_state || [];
    }

    if (exitCode === 0) {
      this._setState(STATES.DONE);
      this.statusReport.outcome = 'applied';
      this._startPostCompletionWindow();
    } else if (exitCode === 1 || exitCode === 2) {
      this._setState(STATES.ERROR_AWAITING_USER);
      this.statusReport.outcome = exitCode === 1 ? 'partial_failure' : 'apply_error';
      this._startIdleTimer();
      this._startHeartbeatWatcher();
    } else {
      // exitCode === 3 or unexpected
      this.statusReport.outcome = 'apply_error';
      this.statusReport.error_detail = `apply-script exited ${exitCode}`;
      this._terminate(STATES.ERROR_INTERNAL, EXIT_CODES.APPLY_FAILED, this.statusReport);
    }
    return true;
  }

  onSignal(sig) {
    const exitCode = sig === 'SIGINT' ? EXIT_CODES.SIGINT : EXIT_CODES.SIGTERM;
    this.statusReport.outcome = 'terminated';
    this._terminate(STATES.TERMINATED, exitCode, this.statusReport);
  }

  onPageClose() {
    // Heartbeat-gap detection delegates here.
    if (this.state === STATES.WAITING || this.state === STATES.ERROR_AWAITING_USER) {
      const code = this.state === STATES.ERROR_AWAITING_USER ? EXIT_CODES.APPLY_FAILED : EXIT_CODES.PAGE_CLOSED;
      this.statusReport.outcome = this.state === STATES.ERROR_AWAITING_USER ? 'apply_error' : 'page_closed';
      this._terminate(STATES.DISCONNECTED, code, this.statusReport);
    } else if (this.state === STATES.DONE) {
      // User saw the success page and closed it. Exit cleanly.
      this._terminate(STATES.DONE, EXIT_CODES.APPLIED, this.statusReport);
    }
    // APPLYING: do NOT cancel — let the apply-script run to completion.
    // Heartbeat absence during APPLYING is logged but does not terminate.
  }

  // ---- Internal ----

  _setState(newState) {
    this.state = newState;
  }

  _terminate(state, exitCode, report) {
    if (this._terminated) return;
    this._terminated = true;
    this._setState(state);
    this._clearTimers();
    Object.assign(this.statusReport, report);
    this.onTerminal({ state, exitCode, statusReport: this.statusReport });
  }

  _captureUserEdits(submittedSpec) {
    // The listener passes the originally-rendered spec and the page-submitted spec.
    // For simplicity, the listener stores edits as a diff that's surfaced here.
    // If submittedSpec is just the spec, we record presence; the listener supplies the diff.
    return submittedSpec ? { spec_at_apply: submittedSpec } : null;
  }

  _startIdleTimer() {
    this._clearTimer('idle');
    this._timers.idle = setTimeout(() => {
      this.statusReport.outcome = 'timed_out';
      this._terminate(STATES.TIMED_OUT, EXIT_CODES.TIMED_OUT, this.statusReport);
    }, this.timing.idleTimeoutMs);
  }

  _startHeartbeatWatcher() {
    this._clearTimer('heartbeat');
    const checkInterval = Math.floor(this.timing.heartbeatExpectedIntervalMs / 2);
    this._timers.heartbeat = setInterval(() => {
      if (this._terminated) return;
      const since = Date.now() - this.lastHeartbeat;
      if (since > this.timing.heartbeatGapMs) {
        this.onPageClose();
      }
    }, checkInterval);
  }

  _startPostCompletionWindow() {
    this._clearTimer('postCompletion');
    this._timers.postCompletion = setTimeout(() => {
      this._terminate(STATES.DONE, EXIT_CODES.APPLIED, this.statusReport);
    }, this.timing.postCompletionWindowMs);
  }

  _startApplyHardTimeout() {
    this._clearTimer('applyHard');
    this._timers.applyHard = setTimeout(() => {
      this.statusReport.outcome = 'apply_error';
      this.statusReport.error_detail = `apply-script did not exit within ${this.timing.applyScriptHardTimeoutMs}ms; assumed crashed`;
      this._terminate(STATES.ERROR_INTERNAL, EXIT_CODES.APPLY_FAILED, this.statusReport);
    }, this.timing.applyScriptHardTimeoutMs);
  }

  _clearTimer(name) {
    if (this._timers[name]) {
      clearTimeout(this._timers[name]);
      clearInterval(this._timers[name]);
      delete this._timers[name];
    }
  }

  _clearTimers() {
    for (const name of Object.keys(this._timers)) this._clearTimer(name);
  }
}

module.exports = { Lifecycle, STATES, EXIT_CODES, DEFAULTS };
