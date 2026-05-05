// Package auth discovers OAuth credentials stashed by the gdrive aifs
// adapter and returns a refreshing token source suitable for Drive API
// client construction.
//
// Token layout (mirrors the Node adapter's gdrive.js):
//
//   <workspace>/agent-index.json
//     remote_filesystem.auth.credential_store  → relative path to creds dir
//     remote_filesystem.connection.client_id   → OAuth client ID
//     remote_filesystem.connection.client_secret → OAuth client secret
//
//   <workspace>/<credential_store>/gdrive.json
//     { access_token, refresh_token, token_type, scope, expiry_date }
//     where expiry_date is milliseconds since epoch
//
// The returned token source automatically refreshes the access token when
// it nears expiry and persists the new token back to gdrive.json so the
// next process picks up the latest credentials.
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

// gdriveToken matches the on-disk shape written by the Node adapter.
// We only surface the fields oauth2.Token needs.
type gdriveToken struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token,omitempty"`
	TokenType    string `json:"token_type,omitempty"`
	Scope        string `json:"scope,omitempty"`
	IDToken      string `json:"id_token,omitempty"`
	// ExpiryDate is milliseconds since epoch (Node's Date.now() form).
	ExpiryDate int64 `json:"expiry_date,omitempty"`
}

func (g *gdriveToken) toOAuth() *oauth2.Token {
	t := &oauth2.Token{
		AccessToken:  g.AccessToken,
		RefreshToken: g.RefreshToken,
		TokenType:    g.TokenType,
	}
	if g.ExpiryDate > 0 {
		t.Expiry = time.UnixMilli(g.ExpiryDate)
	}
	return t
}

func fromOAuth(t *oauth2.Token, scope, idToken string) *gdriveToken {
	g := &gdriveToken{
		AccessToken:  t.AccessToken,
		RefreshToken: t.RefreshToken,
		TokenType:    t.TokenType,
		Scope:        scope,
		IDToken:      idToken,
	}
	if !t.Expiry.IsZero() {
		g.ExpiryDate = t.Expiry.UnixMilli()
	}
	return g
}

// agentIndexConfig is the slice of agent-index.json this package cares about.
type agentIndexConfig struct {
	RemoteFilesystem struct {
		Auth struct {
			CredentialStore string `json:"credential_store"`
		} `json:"auth"`
		Connection struct {
			ClientID     string `json:"client_id"`
			ClientSecret string `json:"client_secret"`
		} `json:"connection"`
	} `json:"remote_filesystem"`
}

// LoadFromWorkspace reads agent-index.json + gdrive.json and returns
// an oauth2 config + token. If the token has no refresh token or the
// gdrive.json file is missing, returns an error.
func LoadFromWorkspace(workspaceRoot string) (*oauth2.Config, *oauth2.Token, string, error) {
	cfgPath := filepath.Join(workspaceRoot, "agent-index.json")
	cfg, err := readAgentIndex(cfgPath)
	if err != nil {
		return nil, nil, "", fmt.Errorf("read %s: %w", cfgPath, err)
	}
	if cfg.RemoteFilesystem.Connection.ClientID == "" {
		return nil, nil, "", errors.New("agent-index.json: remote_filesystem.connection.client_id is empty")
	}
	if cfg.RemoteFilesystem.Connection.ClientSecret == "" {
		return nil, nil, "", errors.New("agent-index.json: remote_filesystem.connection.client_secret is empty")
	}
	credStore := cfg.RemoteFilesystem.Auth.CredentialStore
	if credStore == "" {
		credStore = ".agent-index/credentials/"
	}
	if !filepath.IsAbs(credStore) {
		credStore = filepath.Join(workspaceRoot, credStore)
	}
	tokenPath := filepath.Join(credStore, "gdrive.json")
	bytes, err := os.ReadFile(tokenPath)
	if err != nil {
		return nil, nil, "", fmt.Errorf("read %s: %w (member may need to authenticate via aifs_authenticate)", tokenPath, err)
	}
	var g gdriveToken
	if err := json.Unmarshal(bytes, &g); err != nil {
		return nil, nil, "", fmt.Errorf("parse %s: %w", tokenPath, err)
	}
	if g.RefreshToken == "" {
		return nil, nil, "", fmt.Errorf("%s has no refresh_token; re-authenticate with aifs_authenticate", tokenPath)
	}

	oauthCfg := &oauth2.Config{
		ClientID:     cfg.RemoteFilesystem.Connection.ClientID,
		ClientSecret: cfg.RemoteFilesystem.Connection.ClientSecret,
		Endpoint: oauth2.Endpoint{
			AuthURL:  "https://accounts.google.com/o/oauth2/auth",
			TokenURL: "https://oauth2.googleapis.com/token",
		},
		// Scopes are informational here; they were captured at consent time
		// and the refresh flow doesn't re-request them. We keep what's
		// stored so written-back tokens preserve the field for the Node
		// adapter's benefit.
	}

	return oauthCfg, g.toOAuth(), tokenPath, nil
}

// PersistingTokenSource wraps an oauth2.TokenSource and writes refreshed
// tokens back to gdrive.json on disk so the Node adapter and any other
// concurrent reader picks up the latest credentials.
//
// Concurrency note: gdrive.json is also written by the Node adapter's
// own refresh listener. Two processes refreshing simultaneously may
// race on the file, but Google's OAuth server returns the same access
// token to both within the refresh window — the last writer wins, both
// are valid. We do not implement cross-process locking here; the Node
// adapter doesn't either.
type PersistingTokenSource struct {
	src       oauth2.TokenSource
	tokenPath string
	scope     string
	idToken   string
	mu        sync.Mutex
	last      *oauth2.Token
}

// Token returns a fresh token, refreshing if needed, and persists any new
// token back to disk before returning it.
func (p *PersistingTokenSource) Token() (*oauth2.Token, error) {
	tok, err := p.src.Token()
	if err != nil {
		return nil, err
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.last == nil || tok.AccessToken != p.last.AccessToken {
		if err := writeToken(p.tokenPath, fromOAuth(tok, p.scope, p.idToken)); err != nil {
			// Refresh succeeded but persistence failed — surface as a
			// non-fatal warning via the returned token. The caller can
			// still use the in-memory token; only subsequent processes
			// would miss the update.
			return tok, fmt.Errorf("persist refreshed token to %s: %w", p.tokenPath, err)
		}
		p.last = tok
	}
	return tok, nil
}

// NewTokenSource builds a refreshing, persisting token source rooted at
// the workspace folder.
func NewTokenSource(ctx context.Context, workspaceRoot string) (oauth2.TokenSource, error) {
	cfg, tok, tokenPath, err := LoadFromWorkspace(workspaceRoot)
	if err != nil {
		return nil, err
	}
	// Read existing scope / id_token to round-trip them through writes,
	// so the on-disk file remains compatible with the Node adapter's
	// expectations.
	var existing gdriveToken
	if bytes, err := os.ReadFile(tokenPath); err == nil {
		_ = json.Unmarshal(bytes, &existing)
	}
	src := cfg.TokenSource(ctx, tok)
	return &PersistingTokenSource{
		src:       src,
		tokenPath: tokenPath,
		scope:     existing.Scope,
		idToken:   existing.IDToken,
		last:      tok,
	}, nil
}

func readAgentIndex(path string) (*agentIndexConfig, error) {
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	var cfg agentIndexConfig
	if err := json.Unmarshal(bytes, &cfg); err != nil {
		return nil, err
	}
	return &cfg, nil
}

func writeToken(path string, g *gdriveToken) error {
	bytes, err := json.MarshalIndent(g, "", "  ")
	if err != nil {
		return err
	}
	// Atomic write: temp file + rename. Avoids a torn read by any
	// reader (including the Node adapter) while we're mid-write.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, bytes, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}
