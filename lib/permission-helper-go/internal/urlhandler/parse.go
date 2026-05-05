// Package urlhandler parses agent-index:// URLs and validates them
// before dispatch to the listener.
//
// URL form: agent-index://apply?spec=<path>
// Allowed verbs (v0.1): "apply"
package urlhandler

import (
	"errors"
	"fmt"
	"net/url"
	"path/filepath"
	"strings"
)

const Scheme = "agent-index"

// Allowed verbs. Future verbs require code changes (and a security review).
var allowedVerbs = map[string]bool{
	"apply": true,
}

// ParsedURL is the result of parsing an agent-index:// URL.
type ParsedURL struct {
	Verb     string
	SpecPath string // resolved absolute path, validated to be under the workspace
}

// Parse validates an agent-index:// URL string against the allowed shapes.
// workspaceRoot is the absolute path to the user's workspace folder; the
// spec parameter must resolve to a path under workspaceRoot/outputs/.
func Parse(rawURL, workspaceRoot string) (*ParsedURL, error) {
	u, err := url.Parse(rawURL)
	if err != nil {
		return nil, fmt.Errorf("parse url: %w", err)
	}

	if u.Scheme != Scheme {
		return nil, fmt.Errorf("expected scheme %q, got %q", Scheme, u.Scheme)
	}

	verb := u.Host
	if verb == "" {
		// Some implementations route the verb through the Path instead.
		verb = strings.TrimPrefix(u.Path, "/")
	}
	if !allowedVerbs[verb] {
		return nil, fmt.Errorf("unknown or disallowed verb: %q", verb)
	}

	specParam := u.Query().Get("spec")
	if specParam == "" {
		return nil, errors.New("missing spec parameter")
	}

	resolved, err := resolveSpecPath(specParam, workspaceRoot)
	if err != nil {
		return nil, err
	}

	return &ParsedURL{Verb: verb, SpecPath: resolved}, nil
}

// resolveSpecPath turns the URL's spec parameter (which may be relative
// or absolute) into an absolute path, then validates that the resulting
// path is under workspaceRoot/outputs/. Refuses any traversal outside.
func resolveSpecPath(spec, workspaceRoot string) (string, error) {
	if workspaceRoot == "" {
		return "", errors.New("workspace root is empty")
	}
	abs := spec
	if !filepath.IsAbs(spec) {
		abs = filepath.Join(workspaceRoot, spec)
	}
	abs = filepath.Clean(abs)

	outputsDir := filepath.Clean(filepath.Join(workspaceRoot, "outputs"))
	rel, err := filepath.Rel(outputsDir, abs)
	if err != nil {
		return "", fmt.Errorf("compute relative path: %w", err)
	}
	if strings.HasPrefix(rel, "..") || strings.HasPrefix(rel, string(filepath.Separator)+"..") {
		return "", fmt.Errorf("spec path %q is outside %q", abs, outputsDir)
	}

	return abs, nil
}

// IsURL returns true if s looks like an agent-index:// URL.
// Used by main.go to detect the URL-handler invocation form.
func IsURL(s string) bool {
	return strings.HasPrefix(s, Scheme+"://")
}
