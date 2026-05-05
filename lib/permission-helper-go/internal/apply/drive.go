// drive.go — The real Drive Driver implementation, talking to Google
// Drive's API directly via google.golang.org/api/drive/v3.
package apply

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"golang.org/x/oauth2"
	"google.golang.org/api/drive/v3"
	"google.golang.org/api/googleapi"
	"google.golang.org/api/option"

	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/spec"
)

// DriveDriver is the production Driver. It resolves logical aifs paths
// (e.g. "/CLAUDE.md") to Drive file IDs using a process-local cache
// seeded from the gdrive adapter's path-cache.json, then walks the
// folder tree as needed for cache misses.
type DriveDriver struct {
	svc            *drive.Service
	rootFolderID   string // starting point for path resolution
	driveID        string // shared drive ID, if any (empty for "My Drive")
	supportsAllDrv bool   // pass supportsAllDrives=true on every call when driveID is set

	cacheMu sync.RWMutex
	cache   map[string]string // logical path → Drive file ID
}

// NewDriveDriver constructs a DriveDriver from the workspace's
// agent-index.json + the gdrive credential stash.
func NewDriveDriver(ctx context.Context, workspaceRoot string, ts oauth2.TokenSource) (*DriveDriver, error) {
	cfg, err := readDriveConnection(workspaceRoot)
	if err != nil {
		return nil, fmt.Errorf("read drive connection: %w", err)
	}

	svc, err := drive.NewService(ctx, option.WithTokenSource(ts))
	if err != nil {
		return nil, fmt.Errorf("construct drive service: %w", err)
	}

	d := &DriveDriver{
		svc:            svc,
		rootFolderID:   cfg.RootFolderID,
		driveID:        cfg.DriveID,
		supportsAllDrv: cfg.DriveID != "",
		cache:          make(map[string]string),
	}

	// Seed cache from the Node adapter's path-cache.json. Best-effort —
	// missing or malformed cache is fine; we'll populate via tree walks.
	d.seedFromPathCache(workspaceRoot)

	// "/" always resolves to the root.
	d.cacheMu.Lock()
	if d.rootFolderID != "" {
		d.cache["/"] = d.rootFolderID
	} else if d.driveID != "" {
		d.cache["/"] = d.driveID
	}
	d.cacheMu.Unlock()

	return d, nil
}

// Share creates a permission grant on the resource for the subject.
func (d *DriveDriver) Share(resource, subject, role string) error {
	id, err := d.resolvePath(resource)
	if err != nil {
		return err
	}
	perm := &drive.Permission{
		Type:         "user",
		Role:         role,
		EmailAddress: subject,
	}
	call := d.svc.Permissions.Create(id, perm).
		SendNotificationEmail(false)
	if d.supportsAllDrv {
		call = call.SupportsAllDrives(true)
	}
	if _, err := call.Do(); err != nil {
		return wrapDriveErr("share", err)
	}
	return nil
}

// Unshare removes the permission grant for the subject on the resource.
// Looks up the matching permission ID, then deletes it.
func (d *DriveDriver) Unshare(resource, subject string) error {
	id, err := d.resolvePath(resource)
	if err != nil {
		return err
	}
	permID, err := d.findPermissionID(id, subject)
	if err != nil {
		return err
	}
	if permID == "" {
		// Not present — nothing to do. Idempotent.
		return nil
	}
	call := d.svc.Permissions.Delete(id, permID)
	if d.supportsAllDrv {
		call = call.SupportsAllDrives(true)
	}
	if err := call.Do(); err != nil {
		return wrapDriveErr("unshare", err)
	}
	return nil
}

// TransferOwnership moves ownership of the resource to subject.
// On a shared drive, "ownership" is the organizer role; on My Drive,
// the user must accept the transfer via Drive UI.
func (d *DriveDriver) TransferOwnership(resource, subject string) error {
	id, err := d.resolvePath(resource)
	if err != nil {
		return err
	}
	perm := &drive.Permission{
		Type:         "user",
		Role:         "owner",
		EmailAddress: subject,
	}
	call := d.svc.Permissions.Create(id, perm).
		TransferOwnership(true).
		SendNotificationEmail(true) // Drive forces this for ownership transfers
	if d.supportsAllDrv {
		call = call.SupportsAllDrives(true)
	}
	if _, err := call.Do(); err != nil {
		return wrapDriveErr("transfer_ownership", err)
	}
	return nil
}

// ListPermissions returns the current permission set on the resource as
// a list of (subject, role) pairs.
func (d *DriveDriver) ListPermissions(resource string) ([]spec.Recipient, error) {
	id, err := d.resolvePath(resource)
	if err != nil {
		return nil, err
	}
	var recipients []spec.Recipient
	pageToken := ""
	for {
		call := d.svc.Permissions.List(id).
			Fields("nextPageToken,permissions(id,emailAddress,domain,type,role)").
			PageSize(100)
		if d.supportsAllDrv {
			call = call.SupportsAllDrives(true)
		}
		if pageToken != "" {
			call = call.PageToken(pageToken)
		}
		page, err := call.Do()
		if err != nil {
			return nil, wrapDriveErr("list_permissions", err)
		}
		for _, p := range page.Permissions {
			subj := p.EmailAddress
			if subj == "" {
				subj = p.Domain
			}
			if subj == "" {
				subj = "anyone"
			}
			recipients = append(recipients, spec.Recipient{
				Subject: subj,
				Role:    p.Role,
			})
		}
		if page.NextPageToken == "" {
			break
		}
		pageToken = page.NextPageToken
	}
	return recipients, nil
}

// findPermissionID returns the Drive permission ID for the given subject
// on the file. Returns "" if no matching permission exists.
func (d *DriveDriver) findPermissionID(fileID, subject string) (string, error) {
	pageToken := ""
	for {
		call := d.svc.Permissions.List(fileID).
			Fields("nextPageToken,permissions(id,emailAddress)").
			PageSize(100)
		if d.supportsAllDrv {
			call = call.SupportsAllDrives(true)
		}
		if pageToken != "" {
			call = call.PageToken(pageToken)
		}
		page, err := call.Do()
		if err != nil {
			return "", wrapDriveErr("find_permission", err)
		}
		for _, p := range page.Permissions {
			if strings.EqualFold(p.EmailAddress, subject) {
				return p.Id, nil
			}
		}
		if page.NextPageToken == "" {
			break
		}
		pageToken = page.NextPageToken
	}
	return "", nil
}

// resolvePath turns a logical path like "/shared/updates/" into a
// Drive file ID. Hits the cache first; on miss, walks from the parent
// down via Files.List.
func (d *DriveDriver) resolvePath(p string) (string, error) {
	clean := normalizePath(p)
	d.cacheMu.RLock()
	if id, ok := d.cache[clean]; ok {
		d.cacheMu.RUnlock()
		return id, nil
	}
	d.cacheMu.RUnlock()

	// Walk: split into segments, resolve from root downward.
	parent := d.cache["/"]
	if parent == "" {
		return "", &DriveError{Code: "no_root", Message: "no root folder configured (drive_id and root_folder_id both empty)"}
	}
	segs := strings.Split(strings.Trim(clean, "/"), "/")
	curr := "/"
	currID := parent
	for _, seg := range segs {
		if seg == "" {
			continue
		}
		curr = strings.TrimSuffix(curr, "/") + "/" + seg
		// Cache check at each level.
		d.cacheMu.RLock()
		cached, ok := d.cache[curr]
		d.cacheMu.RUnlock()
		if ok {
			currID = cached
			continue
		}
		childID, err := d.findChild(currID, seg)
		if err != nil {
			return "", err
		}
		if childID == "" {
			return "", &DriveError{Code: "not_found", Message: fmt.Sprintf("path %q does not exist (segment %q under %s)", clean, seg, currID)}
		}
		d.cacheMu.Lock()
		d.cache[curr] = childID
		d.cacheMu.Unlock()
		currID = childID
	}
	return currID, nil
}

// findChild looks up a file/folder named name with parent parentID.
func (d *DriveDriver) findChild(parentID, name string) (string, error) {
	q := fmt.Sprintf("'%s' in parents and name = '%s' and trashed = false",
		parentID, escapeQuery(name))
	call := d.svc.Files.List().
		Q(q).
		Fields("files(id,name)").
		PageSize(10)
	if d.supportsAllDrv {
		call = call.SupportsAllDrives(true).
			IncludeItemsFromAllDrives(true).
			Corpora("drive").
			DriveId(d.driveID)
	}
	page, err := call.Do()
	if err != nil {
		return "", wrapDriveErr("find_child", err)
	}
	if len(page.Files) == 0 {
		return "", nil
	}
	return page.Files[0].Id, nil
}

// seedFromPathCache loads the Node adapter's path-cache.json into
// the in-memory cache. Best-effort.
func (d *DriveDriver) seedFromPathCache(workspaceRoot string) {
	cachePath := filepath.Join(workspaceRoot, ".agent-index", "credentials", "path-cache.json")
	bytes, err := os.ReadFile(cachePath)
	if err != nil {
		return
	}
	var raw struct {
		Entries map[string]struct {
			ID string `json:"id"`
		} `json:"entries"`
	}
	if err := json.Unmarshal(bytes, &raw); err != nil {
		return
	}
	d.cacheMu.Lock()
	defer d.cacheMu.Unlock()
	for path, entry := range raw.Entries {
		if entry.ID != "" {
			d.cache[normalizePath(path)] = entry.ID
		}
	}
}

// driveConnection holds the connection bits we read from agent-index.json.
type driveConnection struct {
	DriveID      string
	RootFolderID string
}

func readDriveConnection(workspaceRoot string) (*driveConnection, error) {
	bytes, err := os.ReadFile(filepath.Join(workspaceRoot, "agent-index.json"))
	if err != nil {
		return nil, err
	}
	var ai struct {
		RemoteFilesystem struct {
			Connection struct {
				DriveID      string `json:"drive_id"`
				RootFolderID string `json:"root_folder_id"`
			} `json:"connection"`
		} `json:"remote_filesystem"`
	}
	if err := json.Unmarshal(bytes, &ai); err != nil {
		return nil, err
	}
	return &driveConnection{
		DriveID:      ai.RemoteFilesystem.Connection.DriveID,
		RootFolderID: ai.RemoteFilesystem.Connection.RootFolderID,
	}, nil
}

func normalizePath(p string) string {
	if p == "" {
		return "/"
	}
	if p[0] != '/' {
		p = "/" + p
	}
	// Drop trailing slash unless it's just "/".
	if len(p) > 1 && p[len(p)-1] == '/' {
		p = p[:len(p)-1]
	}
	return p
}

// escapeQuery escapes single quotes for Drive's query string syntax.
func escapeQuery(s string) string {
	return strings.ReplaceAll(s, "'", `\'`)
}

// wrapDriveErr converts Drive API errors into typed DriveError. Keeps
// the message human-readable; the code is a coarse machine-readable token.
func wrapDriveErr(opName string, err error) error {
	if err == nil {
		return nil
	}
	var gErr *googleapi.Error
	if errors.As(err, &gErr) {
		code := "drive_error"
		switch gErr.Code {
		case 401, 403:
			code = "permission_denied"
		case 404:
			code = "not_found"
		case 429:
			code = "rate_limited"
		case 500, 502, 503, 504:
			code = "drive_unavailable"
		}
		msg := gErr.Message
		if msg == "" {
			msg = gErr.Error()
		}
		return &DriveError{Code: code, Message: fmt.Sprintf("%s: %s", opName, msg)}
	}
	// Network or other generic errors.
	if isNetworkErr(err) {
		return &DriveError{Code: "network_error", Message: fmt.Sprintf("%s: %s", opName, err.Error())}
	}
	return &DriveError{Code: "drive_error", Message: fmt.Sprintf("%s: %s", opName, err.Error())}
}

func isNetworkErr(err error) bool {
	var ue *url.Error
	return errors.As(err, &ue)
}
