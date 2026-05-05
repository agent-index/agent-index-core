// Package browser launches the user's default browser.
//
// Cross-platform via os/exec. Mirrors the Node helper's openBrowser logic.
package browser

import (
	"os"
	"os/exec"
	"runtime"
	"strings"
)

// Open spawns the user's default browser pointed at url, detached.
// Returns nil if the browser was successfully spawned (the spawn — not
// necessarily the actual page render). On failure, returns an error and
// the caller is expected to surface the URL to the user for manual open.
func Open(url string) error {
	cmd, args := commandFor(url)
	c := exec.Command(cmd, args...)
	// Detach: parent shouldn't wait, child shouldn't be killed when parent exits.
	c.Stdin = nil
	c.Stdout = nil
	c.Stderr = nil
	if err := c.Start(); err != nil {
		return err
	}
	// Release so the child outlives us.
	_ = c.Process.Release()
	return nil
}

// commandFor returns the right command + args for the host OS.
// Exported for testing.
func commandFor(url string) (string, []string) {
	switch runtime.GOOS {
	case "darwin":
		return "open", []string{url}
	case "windows":
		// "" as the second arg is the window title (which start expects);
		// without it, start parses the URL as the title and breaks.
		return "cmd", []string{"/c", "start", "", url}
	default: // linux, freebsd, netbsd, openbsd
		if isWSL() {
			if _, err := exec.LookPath("wslview"); err == nil {
				return "wslview", []string{url}
			}
			// Fallback to invoking the Windows host's start command.
			return "cmd.exe", []string{"/c", "start", url}
		}
		return "xdg-open", []string{url}
	}
}

// isWSL detects whether we're running under Windows Subsystem for Linux.
// Same heuristic as the Node helper: read /proc/version and look for "microsoft".
func isWSL() bool {
	if runtime.GOOS != "linux" {
		return false
	}
	b, err := os.ReadFile("/proc/version")
	if err != nil {
		return false
	}
	return strings.Contains(strings.ToLower(string(b)), "microsoft")
}
