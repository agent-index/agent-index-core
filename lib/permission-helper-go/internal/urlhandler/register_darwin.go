//go:build darwin

// register_darwin.go — URL scheme registration on macOS.
//
// macOS expects URL handlers to live inside a .app bundle whose
// Info.plist declares CFBundleURLTypes / CFBundleURLSchemes. The
// installer is responsible for placing the binary inside a minimal
// .app bundle structure; this file's Register() function then asks
// LaunchServices to refresh its handler database for that bundle.
//
// Bundle structure produced by the installer:
//
//   ~/Applications/Agent-Index Helper.app/
//     Contents/
//       Info.plist
//       MacOS/
//         agent-index-show-plan   (the binary, exec name matches CFBundleExecutable)
//
// Register() walks up from os.Executable() to find the .app, then calls
// `lsregister -f -R <bundle>` to register the handler. If no .app
// bundle is found, returns an error pointing the user at the installer.
package urlhandler

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

const lsregisterPath = "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister"

// Register registers the .app bundle containing the running binary.
func Register() error {
	bundle, err := findBundle()
	if err != nil {
		return err
	}
	if out, err := exec.Command(lsregisterPath, "-f", "-R", bundle).CombinedOutput(); err != nil {
		return fmt.Errorf("lsregister -f -R %s: %w (output: %s)", bundle, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Unregister removes the .app bundle's registration from LaunchServices.
func Unregister() error {
	bundle, err := findBundle()
	if err != nil {
		// If we can't locate the bundle, there's nothing to unregister.
		return nil
	}
	if out, err := exec.Command(lsregisterPath, "-u", bundle).CombinedOutput(); err != nil {
		return fmt.Errorf("lsregister -u %s: %w (output: %s)", bundle, err, strings.TrimSpace(string(out)))
	}
	return nil
}

// IsRegistered returns true if LaunchServices' dump shows the bundle as
// the handler for the agent-index:// scheme. Best-effort.
func IsRegistered() (bool, error) {
	bundle, err := findBundle()
	if err != nil {
		return false, nil
	}
	out, err := exec.Command(lsregisterPath, "-dump").CombinedOutput()
	if err != nil {
		return false, fmt.Errorf("lsregister -dump: %w", err)
	}
	dump := string(out)
	// The dump is large. We just look for the bundle path co-occurring
	// with the agent-index scheme. This is heuristic but adequate.
	return strings.Contains(dump, bundle) && strings.Contains(dump, "agent-index:"), nil
}

// findBundle walks up from the running executable looking for an .app
// directory. Returns its absolute path.
func findBundle() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	dir := filepath.Dir(exe)
	for i := 0; i < 6; i++ {
		if strings.HasSuffix(dir, ".app") {
			return dir, nil
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	return "", fmt.Errorf("could not find .app bundle (binary at %s is not inside a .app bundle; run the macOS installer to set this up)", exe)
}
