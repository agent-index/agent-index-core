// mstoken.go — Microsoft Entra (Azure AD) public-client token source for the
// OneDrive/SharePoint backend. Mirrors token.go (Google) but for Microsoft
// Graph, with the key difference that the org's app registration is a PUBLIC
// client: there is NO client_secret. Refresh uses the public-client flow
// (client_id in the body, no client authentication).
//
// Token layout (mirrors the Node onedrive adapter's onedrive.js):
//
//   <workspace>/agent-index.json
//     remote_filesystem.auth.credential_store     → relative path to creds dir
//     remote_filesystem.connection.tenant_id      → Entra tenant (directory) ID
//     remote_filesystem.connection.client_id      → public app (client) ID
//
//   <workspace>/<credential_store>/onedrive.json
//     { access_token, refresh_token, expires_at }
//     where expires_at is milliseconds since epoch (Node Date.now() form)
//
// The returned token source refreshes when the access token nears expiry and
// persists the new token back to onedrive.json so the Node adapter and the
// next helper process pick up the latest credentials.
package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"golang.org/x/oauth2"
)

// Graph delegated scopes. offline_access yields the refresh token; .default
// would pull app-role scopes we don't want. These mirror the Node adapter's
// SCOPES (Files.ReadWrite.All + Sites.ReadWrite.All + User.Read + offline_access).
const microsoftScopes = "offline_access User.Read Files.ReadWrite.All Sites.ReadWrite.All"

// onedriveToken matches the on-disk shape written by the Node onedrive adapter.
type onedriveToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	// ExpiresAt is milliseconds since epoch (Node's Date.now() + expires_in*1000).
	ExpiresAt int64 `json:"expires_at,omitempty"`
}

func (o *onedriveToken) toOAuth() *oauth2.Token {
	t := &oauth2.Token{
		AccessToken:  o.AccessToken,
		RefreshToken: o.RefreshToken,
		TokenType:    "Bearer",
	}
	if o.ExpiresAt > 0 {
		t.Expiry = time.UnixMilli(o.ExpiresAt)
	}
	return t
}

func msFromOAuth(t *oauth2.Token) *onedriveToken {
	o := &onedriveToken{
		AccessToken:  t.AccessToken,
		RefreshToken: t.RefreshToken,
	}
	if !t.Expiry.IsZero() {
		o.ExpiresAt = t.Expiry.UnixMilli()
	}
	return o
}

// msAgentIndexConfig is the slice of agent-index.json this backend cares about.
// Note: NO client_secret — the onedrive app is a public client.
type msAgentIndexConfig struct {
	RemoteFilesystem struct {
		Backend string `json:"backend"`
		Auth    struct {
			CredentialStore string `json:"credential_store"`
		} `json:"auth"`
		Connection struct {
			TenantID string `json:"tenant_id"`
			ClientID string `json:"client_id"`
		} `json:"connection"`
	} `json:"remote_filesystem"`
}

// msPersistingTokenSource refreshes and persists tokens back to onedrive.json.
type msPersistingTokenSource struct {
	src       oauth2.TokenSource
	tokenPath string
	mu        sync.Mutex
	last      *oauth2.Token
}

func (p *msPersistingTokenSource) Token() (*oauth2.Token, error) {
	tok, err := p.src.Token()
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.last == nil || tok.AccessToken != p.last.AccessToken {
		if err := writeMSToken(p.tokenPath, msFromOAuth(tok)); err != nil {
			return tok, fmt.Errorf("persist refreshed token to %s: %w", p.tokenPath, err)
		}
		p.last = tok
	}
	return tok, nil
}

// NewMicrosoftTokenSource builds a refreshing, persisting public-client token
// source rooted at the workspace folder. Returns an error if the workspace
// isn't a OneDrive backend, the app config is missing, or no refresh token is
// stored (the member needs to authenticate via aifs_authenticate).
func NewMicrosoftTokenSource(ctx context.Context, workspaceRoot string) (oauth2.TokenSource, error) {
	cfgPath := filepath.Join(workspaceRoot, "agent-index.json")
	bytes, err := os.ReadFile(cfgPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w", cfgPath, err)
	}
	var cfg msAgentIndexConfig
	if err := json.Unmarshal(bytes, &cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", cfgPath, err)
	}
	conn := cfg.RemoteFilesystem.Connection
	if conn.TenantID == "" || conn.ClientID == "" {
		return nil, errors.New("agent-index.json: remote_filesystem.connection.tenant_id and client_id are required for the onedrive backend")
	}

	credStore := cfg.RemoteFilesystem.Auth.CredentialStore
	if credStore == "" {
		credStore = ".agent-index/credentials/"
	}
	if !filepath.IsAbs(credStore) {
		credStore = filepath.Join(workspaceRoot, credStore)
	}
	tokenPath := filepath.Join(credStore, "onedrive.json")
	tbytes, err := os.ReadFile(tokenPath)
	if err != nil {
		return nil, fmt.Errorf("read %s: %w (member may need to authenticate via aifs_authenticate)", tokenPath, err)
	}
	var o onedriveToken
	if err := json.Unmarshal(tbytes, &o); err != nil {
		return nil, fmt.Errorf("parse %s: %w", tokenPath, err)
	}
	if o.RefreshToken == "" {
		return nil, fmt.Errorf("%s has no refresh_token; re-authenticate with aifs_authenticate", tokenPath)
	}

	// Public client: no secret. AuthStyleInParams sends client_id in the POST
	// body (the public-client refresh flow) rather than as HTTP Basic auth.
	oauthCfg := &oauth2.Config{
		ClientID: conn.ClientID,
		Endpoint: oauth2.Endpoint{
			AuthURL:   fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/authorize", conn.TenantID),
			TokenURL:  fmt.Sprintf("https://login.microsoftonline.com/%s/oauth2/v2.0/token", conn.TenantID),
			AuthStyle: oauth2.AuthStyleInParams,
		},
		Scopes: splitScopes(microsoftScopes),
	}

	tok := o.toOAuth()
	src := oauthCfg.TokenSource(ctx, tok)
	return &msPersistingTokenSource{src: src, tokenPath: tokenPath, last: tok}, nil
}

func splitScopes(s string) []string {
	var out []string
	for _, p := range []byte(s) {
		_ = p
	}
	// simple space split without importing strings twice in this file
	cur := ""
	for i := 0; i < len(s); i++ {
		if s[i] == ' ' {
			if cur != "" {
				out = append(out, cur)
				cur = ""
			}
			continue
		}
		cur += string(s[i])
	}
	if cur != "" {
		out = append(out, cur)
	}
	return out
}

func writeMSToken(path string, o *onedriveToken) error {
	bytes, err := json.MarshalIndent(o, "", "  ")
	if err != nil {
		return err
	}
	// Atomic write: temp file + rename (avoids a torn read by the Node adapter).
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, bytes, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
