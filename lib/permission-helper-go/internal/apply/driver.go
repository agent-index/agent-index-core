// driver.go — The Driver interface and a StubDriver suitable for the
// spike, --stub mode, and tests.
package apply

import (
	"fmt"
	"os"
	"time"

	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/spec"
)

// Driver is the abstraction over the Drive transport. The real
// implementation (DriveDriver in drive.go) talks to Google Drive's API;
// StubDriver below returns canned successful results for testing.
type Driver interface {
	Share(resource, subject, role string) error
	Unshare(resource, subject string) error
	TransferOwnership(resource, subject string) error
	ListPermissions(resource string) ([]spec.Recipient, error)
}

// DriveError is the typed error returned by Driver implementations.
// Code is a short machine-readable token (e.g., "permission_denied",
// "not_found", "network_error"); Message is human-readable detail.
type DriveError struct {
	Code    string
	Message string
}

func (e *DriveError) Error() string {
	return fmt.Sprintf("%s: %s", e.Code, e.Message)
}

// StubDriver simulates a successful Drive client for the spike and tests.
// 100ms latency on every op makes SSE progress visible to the user. Set
// AIFS_HELPER_STUB_FAIL=1 to make every op fail (for testing the
// failure UI).
type StubDriver struct{}

func (StubDriver) Share(resource, subject, role string) error {
	time.Sleep(100 * time.Millisecond)
	if os.Getenv("AIFS_HELPER_STUB_FAIL") != "" {
		return &DriveError{Code: "stub_fail", Message: "AIFS_HELPER_STUB_FAIL set"}
	}
	return nil
}
func (StubDriver) Unshare(resource, subject string) error {
	time.Sleep(100 * time.Millisecond)
	if os.Getenv("AIFS_HELPER_STUB_FAIL") != "" {
		return &DriveError{Code: "stub_fail", Message: "AIFS_HELPER_STUB_FAIL set"}
	}
	return nil
}
func (StubDriver) TransferOwnership(resource, subject string) error {
	time.Sleep(100 * time.Millisecond)
	if os.Getenv("AIFS_HELPER_STUB_FAIL") != "" {
		return &DriveError{Code: "stub_fail", Message: "AIFS_HELPER_STUB_FAIL set"}
	}
	return nil
}
func (StubDriver) ListPermissions(resource string) ([]spec.Recipient, error) {
	return []spec.Recipient{
		{Subject: "stub-owner@example.com", Role: "writer"},
		{Subject: "stub-recipient@example.com", Role: "reader"},
	}, nil
}
