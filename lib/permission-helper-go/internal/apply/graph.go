// graph.go — The OneDrive/SharePoint Driver implementation, talking to
// Microsoft Graph directly via REST (no SDK), mirroring drive.go's shape.
//
// Release B (helper-go v0.5.0). This file is ADDITIVE: it does not touch
// drive.go, driver.go, or apply.go. The gdrive binary's apply path is
// unchanged (O4). A separate cmd (cmd/agent-index-show-plan-onedrive) wires
// this driver; the shared core (apply orchestration, listener, render,
// urlhandler, browser) is reused unchanged.
//
// Sharing is ADDITIVE ONLY. OneDrive/SharePoint inheritance is never broken:
// inherit:false is deprecated (decision 2026-06-15-deprecate-inherit-false) —
// if a v1.1 spec carries it, GraphDriver ignores it and grants additively.
// transferOwnership is not supported on this backend (Graph has no per-item
// ownership transfer); it returns a typed not_implemented error.
package apply

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"golang.org/x/oauth2"

	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/spec"
)

const graphRoot = "https://graph.microsoft.com/v1.0"

// GraphDriver is the production Driver for the OneDrive/SharePoint backend.
// It resolves logical aifs paths (e.g. "/CLAUDE.md") to Graph drive-item IDs
// using a process-local cache seeded from the onedrive adapter's
// path-cache.json, then path-addresses Graph for cache misses. id: anchors
// carry the item ID directly (member-space owned content).
type GraphDriver struct {
	hc       *http.Client // token-injecting client (auto-refresh via oauth2)
	siteID   string
	driveID  string

	cacheMu sync.RWMutex
	cache   map[string]string // logical path → Graph item ID
}

// NewGraphDriver constructs a GraphDriver from the workspace's
// agent-index.json (connection.site_id / drive_id) + the supplied Microsoft
// token source.
func NewGraphDriver(ctx context.Context, workspaceRoot string, ts oauth2.TokenSource) (*GraphDriver, error) {
	cfg, err := readGraphConnection(workspaceRoot)
	if err != nil {
		return nil, fmt.Errorf("read onedrive connection: %w", err)
	}
	d := &GraphDriver{
		hc:      oauth2.NewClient(ctx, ts),
		siteID:  cfg.SiteID,
		driveID: cfg.DriveID,
		cache:   make(map[string]string),
	}
	d.seedFromPathCache(workspaceRoot)
	return d, nil
}

// driveBase returns the Graph drive base for an absolute (org-remote) path.
// SharePoint library when site+drive present; a bare drive; else /me/drive.
func (d *GraphDriver) driveBase() string {
	if d.siteID != "" && d.driveID != "" {
		return fmt.Sprintf("/sites/%s/drives/%s", d.siteID, d.driveID)
	}
	if d.driveID != "" {
		return "/drives/" + d.driveID
	}
	return "/me/drive"
}

// driveBaseFor returns the base for a logical resource. id: anchors live in
// the member's own OneDrive (/me/drive), matching the Node adapter.
func (d *GraphDriver) driveBaseFor(resource string) string {
	if strings.HasPrefix(resource, "id:") {
		return "/me/drive"
	}
	return d.driveBase()
}

// Share grants subject the role at resource (ADDITIVE). inherit is accepted
// for v1.1 spec compatibility but ignored — OneDrive inheritance is never
// broken (decision 2026-06-15-deprecate-inherit-false).
func (d *GraphDriver) Share(resource, subject, role string, inherit *bool) error {
	if inherit != nil && !*inherit {
		fmt.Fprintln(os.Stderr, "[agent-index-show-plan-onedrive] note: inherit:false is deprecated and ignored on onedrive — grant applied additively (parent inheritance unchanged).")
	}
	id, err := d.resolve(resource)
	if err != nil {
		return err
	}
	roles, err := aifsRoleToGraphRoles(role)
	if err != nil {
		return err
	}
	var recipient map[string]string
	if strings.Contains(subject, "@") {
		recipient = map[string]string{"email": subject}
	} else {
		recipient = map[string]string{"objectId": subject}
	}
	body := map[string]interface{}{
		"recipients":     []map[string]string{recipient},
		"roles":          roles,
		"requireSignIn":  true,
		"sendInvitation": false, // agent-index sends its own onboarding mail
	}
	_, err = d.do("POST", fmt.Sprintf("%s/items/%s/invite", d.driveBaseFor(resource), id), body, "share")
	return err
}

// Unshare removes subject's explicit grant at resource. Idempotent: if no
// matching permission exists, returns nil (nothing to do).
func (d *GraphDriver) Unshare(resource, subject string) error {
	id, err := d.resolve(resource)
	if err != nil {
		return err
	}
	permID, err := d.findPermissionID(resource, id, subject)
	if err != nil {
		return err
	}
	if permID == "" {
		return nil
	}
	_, err = d.do("DELETE", fmt.Sprintf("%s/items/%s/permissions/%s", d.driveBaseFor(resource), id, permID), nil, "unshare")
	return err
}

// TransferOwnership is not supported on OneDrive/SharePoint: items are owned
// by the user or the site and Graph has no per-item ownership-transfer analog
// to Drive's. Member departure is handled via the owner_departed pointer
// annotation + M365 admin retention/site action.
func (d *GraphDriver) TransferOwnership(resource, subject string) error {
	return &DriveError{
		Code:    "not_implemented",
		Message: "transfer_ownership is not supported on OneDrive/SharePoint (no per-item ownership transfer in Microsoft Graph). Handle member departure via owner_departed + M365 admin retention.",
	}
}

// ListPermissions returns the current permission set at resource as
// (subject, role) pairs.
func (d *GraphDriver) ListPermissions(resource string) ([]spec.Recipient, error) {
	id, err := d.resolve(resource)
	if err != nil {
		return nil, err
	}
	perms, err := d.listPermissions(resource, id)
	if err != nil {
		return nil, err
	}
	var out []spec.Recipient
	for _, p := range perms {
		out = append(out, spec.Recipient{
			Subject: graphPermSubject(p),
			Role:    graphRolesToAifs(p.Roles),
		})
	}
	return out, nil
}

// ─── Graph permission types ──────────────────────────────────────────────

type graphIdentitySet struct {
	User      *graphIdentity `json:"user,omitempty"`
	SiteUser  *graphIdentity `json:"siteUser,omitempty"`
	Group     *graphIdentity `json:"group,omitempty"`
	SiteGroup *graphIdentity `json:"siteGroup,omitempty"`
}

type graphIdentity struct {
	ID          string `json:"id,omitempty"`
	DisplayName string `json:"displayName,omitempty"`
	Email       string `json:"email,omitempty"`
	LoginName   string `json:"loginName,omitempty"`
}

type graphPermission struct {
	ID                     string               `json:"id"`
	Roles                  []string             `json:"roles"`
	GrantedToV2            *graphIdentitySet    `json:"grantedToV2,omitempty"`
	GrantedToIdentitiesV2  []graphIdentitySet   `json:"grantedToIdentitiesV2,omitempty"`
	GrantedTo              *graphIdentitySet    `json:"grantedTo,omitempty"`
	InheritedFrom          *struct {
		ID   string `json:"id,omitempty"`
		Path string `json:"path,omitempty"`
	} `json:"inheritedFrom,omitempty"`
	Link *struct {
		Scope string `json:"scope,omitempty"`
	} `json:"link,omitempty"`
}

func (d *GraphDriver) listPermissions(resource, id string) ([]graphPermission, error) {
	var all []graphPermission
	next := fmt.Sprintf("%s%s/items/%s/permissions", graphRoot, d.driveBaseFor(resource), id)
	for next != "" {
		respBytes, err := d.doRaw("GET", next, nil, "list_permissions")
		if err != nil {
			return nil, err
		}
		var page struct {
			Value    []graphPermission `json:"value"`
			NextLink string            `json:"@odata.nextLink"`
		}
		if err := json.Unmarshal(respBytes, &page); err != nil {
			return nil, &DriveError{Code: "graph_error", Message: "list_permissions: " + err.Error()}
		}
		all = append(all, page.Value...)
		next = page.NextLink
	}
	return all, nil
}

func (d *GraphDriver) findPermissionID(resource, id, subject string) (string, error) {
	perms, err := d.listPermissions(resource, id)
	if err != nil {
		return "", err
	}
	subjLower := strings.ToLower(subject)
	for _, p := range perms {
		if graphPermMatches(p, subjLower) {
			return p.ID, nil
		}
	}
	return "", nil
}

// ─── Identity / role mapping ──────────────────────────────────────────────

func graphIdentityStrings(s *graphIdentitySet) []string {
	if s == nil {
		return nil
	}
	var out []string
	for _, i := range []*graphIdentity{s.User, s.SiteUser, s.Group, s.SiteGroup} {
		if i != nil {
			out = append(out, i.Email, i.LoginName, i.DisplayName, i.ID)
		}
	}
	return out
}

func graphPermSubject(p graphPermission) string {
	if s := firstNonEmpty(graphIdentityStrings(p.GrantedToV2)...); s != "" {
		return s
	}
	if len(p.GrantedToIdentitiesV2) > 0 {
		var ids []string
		for _, set := range p.GrantedToIdentitiesV2 {
			if s := firstNonEmpty(graphIdentityStrings(&set)...); s != "" {
				ids = append(ids, s)
			}
		}
		if len(ids) > 0 {
			return strings.Join(ids, ", ")
		}
	}
	if s := firstNonEmpty(graphIdentityStrings(p.GrantedTo)...); s != "" {
		return s
	}
	if p.Link != nil {
		return "link:" + p.Link.Scope
	}
	return "unknown"
}

func graphPermMatches(p graphPermission, subjLower string) bool {
	cands := graphIdentityStrings(p.GrantedToV2)
	cands = append(cands, graphIdentityStrings(p.GrantedTo)...)
	for _, set := range p.GrantedToIdentitiesV2 {
		s := set
		cands = append(cands, graphIdentityStrings(&s)...)
	}
	for _, c := range cands {
		if c != "" && strings.ToLower(c) == subjLower {
			return true
		}
	}
	return false
}

// aifsRoleToGraphRoles maps an AIFS role to Graph invite roles (additive).
// commenter→read (OneDrive has no commenter role).
func aifsRoleToGraphRoles(role string) ([]string, error) {
	switch role {
	case "reader", "commenter":
		return []string{"read"}, nil
	case "writer":
		return []string{"write"}, nil
	default:
		return nil, &DriveError{Code: "invalid_role", Message: fmt.Sprintf("role %q is not accepted (valid: reader, commenter, writer)", role)}
	}
}

// graphRolesToAifs maps Graph permission roles[] back to an AIFS role.
func graphRolesToAifs(roles []string) string {
	for _, r := range roles {
		lr := strings.ToLower(r)
		if lr == "write" || lr == "owner" || strings.Contains(lr, "full control") || strings.HasPrefix(lr, "sp.full") {
			return "writer"
		}
	}
	return "reader"
}

func firstNonEmpty(ss ...string) string {
	for _, s := range ss {
		if s != "" {
			return s
		}
	}
	return ""
}

// ─── Path resolution ──────────────────────────────────────────────────────

// resolve turns a logical resource into a Graph drive-item ID. id: anchors
// carry the ID directly; absolute paths are resolved via the cache, then a
// path-addressed Graph metadata GET.
func (d *GraphDriver) resolve(resource string) (string, error) {
	if strings.HasPrefix(resource, "id:") {
		return strings.TrimSuffix(strings.TrimPrefix(resource, "id:"), "/"), nil
	}
	clean := normalizeGraphPath(resource)
	d.cacheMu.RLock()
	if id, ok := d.cache[clean]; ok {
		d.cacheMu.RUnlock()
		return id, nil
	}
	d.cacheMu.RUnlock()

	base := d.driveBase()
	var endpoint string
	if clean == "/" {
		endpoint = fmt.Sprintf("%s%s/root?$select=id", graphRoot, base)
	} else {
		endpoint = fmt.Sprintf("%s%s/root:%s?$select=id", graphRoot, base, pathEscape(clean))
	}
	respBytes, err := d.doRaw("GET", endpoint, nil, "resolve_path")
	if err != nil {
		return "", err
	}
	var item struct {
		ID string `json:"id"`
	}
	if err := json.Unmarshal(respBytes, &item); err != nil || item.ID == "" {
		return "", &DriveError{Code: "not_found", Message: fmt.Sprintf("resolve_path: %q did not resolve to an item", clean)}
	}
	d.cacheMu.Lock()
	d.cache[clean] = item.ID
	d.cacheMu.Unlock()
	return item.ID, nil
}

func (d *GraphDriver) seedFromPathCache(workspaceRoot string) {
	cachePath := filepath.Join(workspaceRoot, ".agent-index", "credentials", "path-cache.json")
	b, err := os.ReadFile(cachePath)
	if err != nil {
		return
	}
	// onedrive adapter path-cache.json: { "entries": { "<path>": { "id": "..." } } }
	var raw struct {
		Entries map[string]struct {
			ID string `json:"id"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(b, &raw); err != nil {
		return
	}
	d.cacheMu.Lock()
	defer d.cacheMu.Unlock()
	for p, e := range raw.Entries {
		if e.ID != "" && !strings.HasPrefix(p, "id:") {
			d.cache[normalizeGraphPath(p)] = e.ID
		}
	}
}

// ─── connection + HTTP plumbing ───────────────────────────────────────────

type graphConnection struct {
	SiteID  string
	DriveID string
}

func readGraphConnection(workspaceRoot string) (*graphConnection, error) {
	b, err := os.ReadFile(filepath.Join(workspaceRoot, "agent-index.json"))
	if err != nil {
		return nil, err
	}
	var ai struct {
		RemoteFilesystem struct {
			Connection struct {
				SiteID  string `json:"site_id"`
				DriveID string `json:"drive_id"`
			} `json:"connection"`
		} `json:"remote_filesystem"`
	}
	if err := json.Unmarshal(b, &ai); err != nil {
		return nil, err
	}
	return &graphConnection{
		SiteID:  ai.RemoteFilesystem.Connection.SiteID,
		DriveID: ai.RemoteFilesystem.Connection.DriveID,
	}, nil
}

// do issues a Graph request with a JSON body (or nil) and discards the body on
// success (used for invite/delete). Returns the response bytes for callers
// that need them via doRaw.
func (d *GraphDriver) do(method, pathOrURL string, body interface{}, opName string) ([]byte, error) {
	u := pathOrURL
	if !strings.HasPrefix(u, "https://") {
		u = graphRoot + u
	}
	return d.doRaw(method, u, body, opName)
}

func (d *GraphDriver) doRaw(method, fullURL string, body interface{}, opName string) ([]byte, error) {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return nil, &DriveError{Code: "graph_error", Message: opName + ": marshal body: " + err.Error()}
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequest(method, fullURL, reader)
	if err != nil {
		return nil, &DriveError{Code: "graph_error", Message: opName + ": " + err.Error()}
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	var resp *http.Response
	// One bounded retry on 429/503 honoring Retry-After.
	for attempt := 0; attempt < 2; attempt++ {
		resp, err = d.hc.Do(req)
		if err != nil {
			return nil, wrapGraphErr(opName, 0, err.Error())
		}
		if resp.StatusCode != 429 && resp.StatusCode != 503 {
			break
		}
		wait := parseRetryAfter(resp.Header.Get("Retry-After"))
		resp.Body.Close()
		if attempt == 0 {
			time.Sleep(wait)
			// rebuild the body reader for the retry
			if body != nil {
				b, _ := json.Marshal(body)
				req, _ = http.NewRequest(method, fullURL, bytes.NewReader(b))
				req.Header.Set("Content-Type", "application/json")
			} else {
				req, _ = http.NewRequest(method, fullURL, nil)
			}
		}
	}
	defer resp.Body.Close()
	respBytes, _ := io.ReadAll(resp.Body)
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		msg := graphErrorMessage(respBytes)
		return nil, wrapGraphErr(opName, resp.StatusCode, msg)
	}
	return respBytes, nil
}

func graphErrorMessage(b []byte) string {
	var e struct {
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
		} `json:"error"`
	}
	if json.Unmarshal(b, &e) == nil && e.Error.Message != "" {
		if e.Error.Code != "" {
			return e.Error.Code + ": " + e.Error.Message
		}
		return e.Error.Message
	}
	return strings.TrimSpace(string(b))
}

// wrapGraphErr maps a Graph HTTP status to a typed DriveError, reusing the
// same Code vocabulary as the Drive driver so the page/CLI render uniformly.
func wrapGraphErr(opName string, status int, msg string) error {
	code := "graph_error"
	switch status {
	case 0:
		code = "network_error"
	case 400:
		if strings.Contains(strings.ToLower(msg), "does not exist") || strings.Contains(strings.ToLower(msg), "could not be found") || strings.Contains(strings.ToLower(msg), "invalid") {
			code = "invalid_recipient"
		} else {
			code = "graph_error"
		}
	case 401, 403:
		code = "permission_denied"
	case 404:
		code = "not_found"
	case 429:
		code = "rate_limited"
	case 500, 502, 503, 504:
		code = "graph_unavailable"
	}
	return &DriveError{Code: code, Message: fmt.Sprintf("%s: %s", opName, msg)}
}

func parseRetryAfter(h string) time.Duration {
	if h == "" {
		return 2 * time.Second
	}
	var secs int
	if _, err := fmt.Sscanf(h, "%d", &secs); err == nil && secs > 0 {
		if secs > 10 {
			secs = 10
		}
		return time.Duration(secs) * time.Second
	}
	return 2 * time.Second
}

func normalizeGraphPath(p string) string {
	if p == "" {
		return "/"
	}
	if p[0] != '/' {
		p = "/" + p
	}
	for strings.Contains(p, "//") {
		p = strings.ReplaceAll(p, "//", "/")
	}
	if len(p) > 1 && p[len(p)-1] == '/' {
		p = p[:len(p)-1]
	}
	return p
}

// pathEscape percent-encodes each path segment for Graph's root:/path
// addressing while preserving the slashes.
func pathEscape(p string) string {
	segs := strings.Split(p, "/")
	for i, s := range segs {
		segs[i] = url.PathEscape(s)
	}
	return strings.Join(segs, "/")
}
