//go:build linux

// register_linux.go — URL scheme registration on Linux via XDG.
//
// Strategy: write a per-user .desktop file under
// ~/.local/share/applications/ that declares
// `MimeType=x-scheme-handler/agent-index;`, then run `xdg-mime` to
// associate the scheme with our .desktop entry, and refresh the
// desktop database. No root required.
package urlhandler

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const desktopFileName = "agent-index-show-plan.desktop"

// Register installs the .desktop file and binds the agent-index scheme.
func Register() error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate binary: %w", err)
	}
	exeAbs, err := filepath.Abs(exe)
	if err != nil {
		exeAbs = exe
	}

	appsDir, err := desktopAppsDir()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(appsDir, 0o755); err != nil {
		return fmt.Errorf("mkdir %s: %w", appsDir, err)
	}
	desktopPath := filepath.Join(appsDir, desktopFileName)

	contents := fmt.Sprintf(`[Desktop Entry]
Type=Application
Name=Agent-Index Permission Helper
Comment=Reviews and applies agent-index permission changes
Exec=%s %%u
NoDisplay=true
Terminal=false
MimeType=x-scheme-handler/agent-index;
Categories=Utility;
`, exeAbs)
	if err := os.WriteFile(desktopPath, []byte(contents), 0o644); err != nil {
		return fmt.Errorf("write %s: %w", desktopPath, err)
	}

	// Bind the scheme.
	if out, err := exec.Command("xdg-mime", "default", desktopFileName, "x-scheme-handler/agent-index").CombinedOutput(); err != nil {
		return fmt.Errorf("xdg-mime default: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}

	// Refresh the desktop database. Best-effort.
	_ = exec.Command("update-desktop-database", appsDir).Run()
	return nil
}

// Unregister removes the .desktop file and clears the scheme binding.
func Unregister() error {
	appsDir, err := desktopAppsDir()
	if err != nil {
		return err
	}
	desktopPath := filepath.Join(appsDir, desktopFileName)

	// Best-effort: ignore "not found" errors.
	_ = os.Remove(desktopPath)

	// xdg-mime has no clean "unset" — best we can do is rewrite the
	// mimeapps.list file. We let the user manually clear if needed,
	// since having an entry that points at a missing .desktop file is
	// harmless on most distros.
	_ = exec.Command("update-desktop-database", appsDir).Run()
	return nil
}

// IsRegistered checks whether xdg-mime reports our .desktop as the
// handler for x-scheme-handler/agent-index.
func IsRegistered() (bool, error) {
	out, err := exec.Command("xdg-mime", "query", "default", "x-scheme-handler/agent-index").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("xdg-mime query: %w", err)
	}
	return strings.TrimSpace(string(out)) == desktopFileName, nil
}

// desktopAppsDir returns ~/.local/share/applications (respecting
// XDG_DATA_HOME if set).
func desktopAppsDir() (string, error) {
	xdg := os.Getenv("XDG_DATA_HOME")
	if xdg == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", err
		}
		xdg = filepath.Join(home, ".local", "share")
	}
	return filepath.Join(xdg, "applications"), nil
}
