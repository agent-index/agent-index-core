//go:build windows

// register_windows.go — URL scheme registration on Windows.
//
// Strategy: per-user registry keys under HKCU\Software\Classes\agent-index.
// No admin rights required. Layout:
//
//   HKCU\Software\Classes\agent-index
//     (default)          = "URL:Agent-Index Permission Helper"
//     URL Protocol       = ""
//   HKCU\Software\Classes\agent-index\DefaultIcon
//     (default)          = "<binary>,1"
//   HKCU\Software\Classes\agent-index\shell\open\command
//     (default)          = "\"<binary>\" \"%1\""
//
// We shell out to reg.exe rather than depending on golang.org/x/sys/windows
// to keep the binary's external deps minimal (only oauth2 + drive).
package urlhandler

import (
	"fmt"
	"os"
	"os/exec"
	"strings"
)

// Register installs the agent-index:// scheme handler in the current user's
// registry. Returns an error with diagnostic detail on any reg.exe failure.
func Register() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate binary: %w", err)
	}
	cmdValue := fmt.Sprintf(`"%s" "%%1"`, exe)
	iconValue := fmt.Sprintf(`%s,1`, exe)

	steps := []struct {
		key, name, vtype, value string
	}{
		{`HKCU\Software\Classes\agent-index`, "", "REG_SZ", "URL:Agent-Index Permission Helper"},
		{`HKCU\Software\Classes\agent-index`, "URL Protocol", "REG_SZ", ""},
		{`HKCU\Software\Classes\agent-index\DefaultIcon`, "", "REG_SZ", iconValue},
		{`HKCU\Software\Classes\agent-index\shell\open\command`, "", "REG_SZ", cmdValue},
	}

	for _, s := range steps {
		args := []string{"add", s.key, "/f", "/t", s.vtype, "/d", s.value}
		if s.name != "" {
			args = append(args, "/v", s.name)
		} else {
			args = append(args, "/ve")
		}
		if out, err := runReg(args...); err != nil {
			return fmt.Errorf("reg %s %q: %w (output: %s)", s.key, s.name, err, strings.TrimSpace(out))
		}
	}
	return nil
}

// Unregister removes the scheme handler. Best-effort: ignores "key not
// found" errors so it's safe to run on a fresh system.
func Unregister() error {
	keys := []string{
		`HKCU\Software\Classes\agent-index\shell\open\command`,
		`HKCU\Software\Classes\agent-index\shell\open`,
		`HKCU\Software\Classes\agent-index\shell`,
		`HKCU\Software\Classes\agent-index\DefaultIcon`,
		`HKCU\Software\Classes\agent-index`,
	}
	for _, k := range keys {
		out, err := runReg("delete", k, "/f")
		if err != nil && !strings.Contains(out, "unable to find") {
			// "ERROR: The system was unable to find the specified registry
			// key or value." is fine — already gone.
			return fmt.Errorf("reg delete %s: %w (output: %s)", k, err, strings.TrimSpace(out))
		}
	}
	return nil
}

// IsRegistered returns true if the scheme handler points at the current
// binary. Used by installers to verify post-install.
func IsRegistered() (bool, error) {
	out, err := runReg("query", `HKCU\Software\Classes\agent-index\shell\open\command`, "/ve")
	if err != nil {
		if strings.Contains(out, "unable to find") {
			return false, nil
		}
		return false, fmt.Errorf("reg query: %w", err)
	}
	exe, err := os.Executable()
	if err != nil {
		return false, err
	}
	// reg.exe output looks like:
	//   (Default)    REG_SZ    "C:\path\to\binary.exe" "%1"
	return strings.Contains(out, exe), nil
}

func runReg(args ...string) (string, error) {
	cmd := exec.Command("reg.exe", args...)
	out, err := cmd.CombinedOutput()
	return string(out), err
}
