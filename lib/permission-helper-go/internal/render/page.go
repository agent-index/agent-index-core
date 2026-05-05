// Package render produces the HTML review page from the embedded template.
//
// The template (templates/page.html, embedded via go:embed) is byte-for-byte
// identical to the Node helper's templates/page.html. Substitutes two
// placeholders:
//   __SPEC__   → JSON-encoded spec
//   __TOKEN__  → one-time session token (UUID, sanitized)
package render

import (
	_ "embed"
	"encoding/json"
	"regexp"
	"strings"
)

//go:embed templates/page.html
//
// NOTE for the implementer: Go's embed.FS requires the embed directive's
// path to be relative to the file containing it. We use a copy of the
// page.html in this package's templates/ directory rather than reaching
// up into the parent directory's templates/. The two should remain
// byte-identical; a build-time check (in goreleaser pre-build hook)
// can verify they match.
var pageTemplate string

var tokenSafe = regexp.MustCompile(`[^a-zA-Z0-9-]`)

// Render returns the final HTML page with the spec and token substituted.
// Spec serialization is via encoding/json; the result is escaped to be
// safe inside a <script type="application/json"> block. The token is
// stripped of any non-UUID-safe characters as defense-in-depth.
func Render(spec interface{}, token string) (string, error) {
	specJSON, err := json.Marshal(spec)
	if err != nil {
		return "", err
	}
	// Defensive: ensure </ inside the JSON cannot escape the script block.
	// JSON.Marshal won't produce bare </ in normal output but we replace
	// to match the Node helper's defensive pattern.
	safeSpec := strings.ReplaceAll(string(specJSON), "</", `<\/`)

	safeToken := tokenSafe.ReplaceAllString(token, "")

	out := pageTemplate
	out = strings.Replace(out, "__SPEC__", safeSpec, 1)
	out = strings.Replace(out, "__TOKEN__", safeToken, 1)
	return out, nil
}
