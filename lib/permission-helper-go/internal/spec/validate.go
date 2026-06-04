package spec

import (
	"fmt"
	"regexp"
	"strings"
)

var emailRegex = regexp.MustCompile(`^[^@\s]+@[^@\s]+\.[^@\s]+$`)

// idAnchorRegex matches ID-anchor resources of the form "id:{driveFolderId}"
// (optional trailing slash). Added in v0.4.0 for the owned-content sharing
// model: member-space folders are not path-addressable (non-admins cannot
// enumerate /members/), so specs reference the granted folder's Drive ID
// directly — captured by the calling task via aifs_stat (adapter 2.5.0+).
// Deliberately strict: exact ID only, no relative path suffix; callers must
// pass the ID of the precise folder being granted.
var idAnchorRegex = regexp.MustCompile(`^id:[A-Za-z0-9_-]+/?$`)

// Result is the outcome of validation.
type Result struct {
	OK     bool
	Errors []string
}

// Validate checks a spec against the schema. Mirror of validate.js.
// Canonical names match Drive's API: lowercase roles, "subject"
// for recipient identifiers in before.recipients.
func Validate(s *Spec) Result {
	var errs []string

	if s == nil {
		return Result{OK: false, Errors: []string{"spec must not be nil"}}
	}

	// version — accept v1.0 OR v1.1
	if s.Version != SchemaVersion && s.Version != SchemaVersionV11 {
		errs = append(errs, fmt.Sprintf("spec.version must be %q or %q (got: %q)", SchemaVersion, SchemaVersionV11, s.Version))
	}

	// v1.0 specs must not include the inherit field (forward-compatibility discipline:
	// v1.0 doesn't define inherit; specs using it MUST declare version 1.1)
	if s.Version == SchemaVersion {
		for i, op := range s.Operations {
			if op.Inherit != nil {
				errs = append(errs, fmt.Sprintf("spec.operations[%d].inherit is not allowed in v1.0 specs (got: %v); use spec.version=%q", i, *op.Inherit, SchemaVersionV11))
			}
		}
	}

	// operations
	if len(s.Operations) == 0 {
		errs = append(errs, "spec.operations must be non-empty")
	} else {
		for i, op := range s.Operations {
			errs = append(errs, validateOp(op, i)...)
		}
		// At most one transfer_ownership.
		var transfers int
		for _, op := range s.Operations {
			if op.Op == "transfer_ownership" {
				transfers++
			}
		}
		if transfers > 1 {
			errs = append(errs, fmt.Sprintf("spec.operations: at most one transfer_ownership per spec (got: %d)", transfers))
		}
		// transfer_ownership recipient cannot be the requestor.
		for i, op := range s.Operations {
			if op.Op == "transfer_ownership" && op.Recipient == s.Context.Requestor {
				errs = append(errs, fmt.Sprintf("spec.operations[%d]: cannot transfer ownership to the requestor", i))
			}
		}
	}

	// context
	if strings.TrimSpace(s.Context.Requestor) == "" {
		errs = append(errs, "spec.context.requestor must be a non-empty string (member_hash)")
	}
	if strings.TrimSpace(s.Context.Purpose) == "" {
		errs = append(errs, "spec.context.purpose must be a non-empty string")
	}

	// mode (optional)
	if s.Mode != "" && !allowedModes[s.Mode] {
		errs = append(errs, fmt.Sprintf("spec.mode, if present, must be one of: fail_soft, all_or_nothing (got: %q)", s.Mode))
	}

	return Result{OK: len(errs) == 0, Errors: errs}
}

func validateOp(op Op, i int) []string {
	prefix := fmt.Sprintf("spec.operations[%d]", i)
	var errs []string

	if !allowedOps[op.Op] {
		errs = append(errs, fmt.Sprintf("%s.op must be one of: share, unshare, transfer_ownership (got: %q)", prefix, op.Op))
	}

	if !strings.HasPrefix(op.Resource, "/") && !idAnchorRegex.MatchString(op.Resource) {
		errs = append(errs, fmt.Sprintf("%s.resource must be a path starting with %q or an ID anchor of the form \"id:{folderId}\" (got: %q)", prefix, "/", op.Resource))
	}

	if !emailRegex.MatchString(op.Recipient) {
		errs = append(errs, fmt.Sprintf("%s.recipient must be a valid email address (got: %q)", prefix, op.Recipient))
	}

	if op.Op == "share" {
		if !allowedRoles[op.Role] {
			errs = append(errs, fmt.Sprintf("%s.role for share ops must be one of: reader, commenter, writer (got: %q)", prefix, op.Role))
		}
	}

	if op.Before != nil {
		for j, r := range op.Before.Recipients {
			if r.Subject == "" || r.Role == "" {
				errs = append(errs, fmt.Sprintf("%s.before.recipients[%d] must have non-empty subject and role", prefix, j))
			}
		}
	}

	return errs
}

// ApplyExclusions returns a fresh Spec with operations marked Excluded=true filtered out.
func ApplyExclusions(s *Spec) *Spec {
	out := *s
	out.Operations = make([]Op, 0, len(s.Operations))
	for _, op := range s.Operations {
		if !op.Excluded {
			out.Operations = append(out.Operations, op)
		}
	}
	return &out
}
