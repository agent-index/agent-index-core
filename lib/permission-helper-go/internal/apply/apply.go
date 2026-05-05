// Package apply runs the actual Drive permission ops.
//
// Orchestration of share/unshare/transfer_ownership ops is in this file.
// The Driver interface (driver.go) abstracts the underlying transport so
// we can swap the real Drive client (drive.go) for a stub (stubdriver.go)
// in tests and the early spike.
package apply

import (
	"encoding/json"
	"fmt"
	"time"

	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/listener"
	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/spec"
)

// EventEmitter is the contract by which the apply-script signals progress.
// Implementations include the SSE broadcaster (in production) and a no-op
// (in --cli mode where progress goes to stderr instead).
type EventEmitter interface {
	OpPending(opIndex int, op spec.Op)
	OpComplete(opIndex int, verifiedRecipients []spec.Recipient)
	OpFailed(opIndex int, code, message string)
}

// Apply runs all operations in s using the supplied driver. Mode controls
// fail-soft (default) vs all-or-nothing semantics.
func Apply(s *spec.Spec, emit EventEmitter, drv Driver) listener.StatusReport {
	mode := s.Mode
	if mode == "" {
		mode = "fail_soft"
	}

	report := listener.StatusReport{
		AppliedOperations: []int{},
		FailedOperations:  []listener.FailedOp{},
		VerifiedPostState: []listener.VerifiedRow{},
	}

	for i, op := range s.Operations {
		if op.Excluded {
			continue
		}
		emit.OpPending(i, op)

		if err := applyOne(op, drv); err != nil {
			code, msg := classifyError(err)
			emit.OpFailed(i, code, msg)
			report.FailedOperations = append(report.FailedOperations, listener.FailedOp{
				OpIndex: i,
				Error: listener.ErrorBlock{
					Code:    code,
					Message: msg,
				},
			})
			if mode == "all_or_nothing" {
				break
			}
			continue
		}

		// Verify post-state.
		verified, err := drv.ListPermissions(op.Resource)
		if err != nil {
			code, msg := classifyError(err)
			// The op succeeded but post-state verification failed. Surface
			// this as a non-fatal warning by appending to AppliedOperations
			// and emitting OpComplete with empty recipients — the user can
			// re-verify manually.
			emit.OpFailed(i, "verification_failed", fmt.Sprintf("%s: %s", code, msg))
			report.FailedOperations = append(report.FailedOperations, listener.FailedOp{
				OpIndex: i,
				Error: listener.ErrorBlock{
					Code:    "verification_failed",
					Message: msg,
				},
			})
			if mode == "all_or_nothing" {
				break
			}
			continue
		}
		emit.OpComplete(i, verified)

		report.AppliedOperations = append(report.AppliedOperations, i)
		report.VerifiedPostState = append(report.VerifiedPostState, listener.VerifiedRow{
			OpIndex:    i,
			Resource:   op.Resource,
			Recipients: recipientsToMaps(verified),
		})
	}

	if len(report.FailedOperations) == 0 {
		report.Outcome = "applied"
	} else if len(report.AppliedOperations) > 0 {
		report.Outcome = "partial_failure"
	} else {
		report.Outcome = "apply_error"
	}

	return report
}

// applyOne dispatches a single op to the driver. Returns an error if the
// op fails (including from validation, network errors, or Drive API errors).
func applyOne(op spec.Op, drv Driver) error {
	switch op.Op {
	case "share":
		return drv.Share(op.Resource, op.Recipient, op.Role)
	case "unshare":
		return drv.Unshare(op.Resource, op.Recipient)
	case "transfer_ownership":
		return drv.TransferOwnership(op.Resource, op.Recipient)
	default:
		return fmt.Errorf("unknown op type: %s", op.Op)
	}
}

func recipientsToMaps(rs []spec.Recipient) []map[string]string {
	out := make([]map[string]string, len(rs))
	for i, r := range rs {
		out[i] = map[string]string{"subject": r.Subject, "role": r.Role}
	}
	return out
}

// MarshalEvent is used by the listener to serialize SSE events.
// (Defined here so the apply package and listener package agree on shape.)
func MarshalEvent(eventType string, data interface{}) ([]byte, error) {
	wrapper := map[string]interface{}{
		"type": eventType,
		"ts":   time.Now().UnixMilli(),
	}
	switch v := data.(type) {
	case map[string]interface{}:
		for k, val := range v {
			wrapper[k] = val
		}
	default:
		return nil, fmt.Errorf("unsupported data shape: %T", data)
	}
	return json.Marshal(wrapper)
}

// classifyError maps an error to (code, message) for the StatusReport.
// Today it's a passthrough; future work can introduce typed error codes
// for permission_denied, not_found, network_error, etc.
func classifyError(err error) (code, msg string) {
	if err == nil {
		return "", ""
	}
	if dErr, ok := err.(*DriveError); ok {
		return dErr.Code, dErr.Message
	}
	return "apply_error", err.Error()
}
