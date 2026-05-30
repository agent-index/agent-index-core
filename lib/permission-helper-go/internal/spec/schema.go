// Package spec defines the permission-change spec types and validation.
//
// Canonical names match Drive's API and aifs_get_permissions output:
//   - Roles are lowercase: "reader", "commenter", "writer"
//   - Recipient identifiers in before.recipients use "subject"
//
// op.recipient stays "recipient" (it's a verb-shaped field — "the
// recipient of this share").
package spec

const (
	SchemaVersion    = "1.0" // legacy spec format
	SchemaVersionV11 = "1.1" // adds optional Inherit field on share ops
)

// Spec is the permission-change spec the agent generates and the
// helper applies. JSON-marshaled to/from disk.
type Spec struct {
	Version    string  `json:"version"`
	Operations []Op    `json:"operations"`
	Context    Context `json:"context"`
	Mode       string  `json:"mode,omitempty"`
}

// Op is a single permission change.
type Op struct {
	Op        string  `json:"op"` // "share" | "unshare" | "transfer_ownership"
	Resource  string  `json:"resource"`
	Recipient string  `json:"recipient"`        // the new recipient being granted/transferred
	Role      string  `json:"role,omitempty"`   // required for op=share; lowercase reader/commenter/writer
	Inherit   *bool   `json:"inherit,omitempty"` // v1.1+ only; nil/true = default Drive inheritance; false = override inheritance (set inheritedPermissionsDisabled=true)
	Before    *Before `json:"before,omitempty"`
	Excluded  bool    `json:"excluded,omitempty"` // set by the page on submit
}

// Before is the optional pre-state at the resource. Used for the page's
// diff visualization. Same shape as aifs_get_permissions returns.
type Before struct {
	Recipients []Recipient `json:"recipients"`
}

// Recipient is one entry in a Drive permissions list. Mirrors the
// shape aifs_get_permissions returns.
type Recipient struct {
	Subject string `json:"subject"`            // email, group address, or "*" for anyone
	Role    string `json:"role"`               // lowercase: reader/commenter/writer/owner
}

// Context is metadata about who's requesting and why.
type Context struct {
	Requestor   string `json:"requestor"`              // member_hash
	CallingTask string `json:"calling_task,omitempty"` // e.g. "invite-member"
	Purpose     string `json:"purpose"`                // plain-English summary
}

// Allowed values, kept in sync with validate.js.
var (
	allowedOps   = map[string]bool{"share": true, "unshare": true, "transfer_ownership": true}
	allowedRoles = map[string]bool{"reader": true, "commenter": true, "writer": true}
	allowedModes = map[string]bool{"fail_soft": true, "all_or_nothing": true}
)
