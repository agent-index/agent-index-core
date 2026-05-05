// HTTP server + SSE + endpoint handlers.
//
// Endpoints, all gated by token + origin check:
//   GET  /                  → rendered HTML page
//   GET  /events?token=...  → SSE event stream
//   POST /heartbeat         → page liveness signal (204)
//   POST /apply             → user clicked Confirm; spawn apply (202)
//   POST /reject            → user clicked Reject (202)
//   POST /retry             → user clicked Retry after partial failure (202)
package listener

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/agent-index/agent-index-core/lib/permission-helper-go/internal/spec"
)

const maxBodyBytes = 1 << 20 // 1 MB

// Server bundles the lifecycle, the HTTP server, and the SSE clients.
type Server struct {
	Spec      *spec.Spec
	Token     string
	Lifecycle *Lifecycle
	Render    func(spec interface{}, token string) (string, error)
	OnApply   func(*spec.Spec) // called when the user clicks Confirm; runs the apply

	mu          sync.Mutex
	port        int
	httpServer  *http.Server
	listener    net.Listener
	sseClients  map[chan []byte]struct{}
	keepalive   *time.Ticker
	stopKeepalive chan struct{}
}

// Start binds to localhost on a random port and begins serving.
// Returns the bound port for use in the URL the binary tells the user to open.
func (s *Server) Start() (int, error) {
	s.sseClients = make(map[chan []byte]struct{})
	s.stopKeepalive = make(chan struct{})

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, fmt.Errorf("bind localhost: %w", err)
	}
	s.listener = ln
	s.port = ln.Addr().(*net.TCPAddr).Port

	mux := http.NewServeMux()
	mux.HandleFunc("/", s.tokenAndOrigin(s.handleIndex))
	mux.HandleFunc("/events", s.tokenAndOrigin(s.handleEvents))
	mux.HandleFunc("/heartbeat", s.tokenAndOrigin(s.handleHeartbeat))
	mux.HandleFunc("/apply", s.tokenAndOrigin(s.handleApply))
	mux.HandleFunc("/reject", s.tokenAndOrigin(s.handleReject))
	mux.HandleFunc("/retry", s.tokenAndOrigin(s.handleRetry))

	s.httpServer = &http.Server{
		Handler:     mux,
		ReadTimeout: 30 * time.Second,
	}

	go func() { _ = s.httpServer.Serve(ln) }()

	s.keepalive = time.NewTicker(15 * time.Second)
	go s.keepaliveLoop()

	return s.port, nil
}

// URL returns the URL the binary should ask the browser to open.
func (s *Server) URL() string {
	return fmt.Sprintf("http://127.0.0.1:%d/?token=%s", s.port, s.Token)
}

// Shutdown closes the server and all SSE clients.
func (s *Server) Shutdown() {
	s.mu.Lock()
	if s.stopKeepalive != nil {
		close(s.stopKeepalive)
		s.stopKeepalive = nil
	}
	for ch := range s.sseClients {
		close(ch)
	}
	s.sseClients = nil
	s.mu.Unlock()

	if s.httpServer != nil {
		_ = s.httpServer.Close()
	}
}

// Broadcast sends an event to all connected SSE clients.
// Non-blocking: a slow client gets dropped rather than holding up the broadcast.
func (s *Server) Broadcast(event map[string]interface{}) {
	data, err := json.Marshal(event)
	if err != nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.sseClients {
		select {
		case ch <- data:
		default:
			// slow client; drop
		}
	}
}

// keepaliveLoop emits an SSE "keepalive" event every 15s.
func (s *Server) keepaliveLoop() {
	for {
		s.mu.Lock()
		stop := s.stopKeepalive
		s.mu.Unlock()
		if stop == nil {
			return
		}
		select {
		case <-stop:
			return
		case <-s.keepalive.C:
			s.Broadcast(map[string]interface{}{"type": "keepalive"})
		}
	}
}

// tokenAndOrigin is middleware: requires a matching token (query string for
// GET, X-Session-Token header for POST) and a same-origin/null origin.
func (s *Server) tokenAndOrigin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var token string
		if r.Method == http.MethodGet {
			token = r.URL.Query().Get("token")
		} else {
			token = r.Header.Get("X-Session-Token")
		}
		if token != s.Token {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		origin := r.Header.Get("Origin")
		if origin != "" {
			expected := fmt.Sprintf("http://127.0.0.1:%d", s.port)
			expectedAlt := fmt.Sprintf("http://localhost:%d", s.port)
			if origin != expected && origin != expectedAlt {
				http.Error(w, "forbidden origin", http.StatusForbidden)
				return
			}
		}
		next(w, r)
	}
}

func (s *Server) handleIndex(w http.ResponseWriter, r *http.Request) {
	html, err := s.Render(s.Spec, s.Token)
	if err != nil {
		http.Error(w, "render failed", http.StatusInternalServerError)
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	_, _ = io.WriteString(w, html)
}

func (s *Server) handleEvents(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	// Initial connected event.
	_, _ = fmt.Fprintf(w, "data: {\"type\":\"connected\"}\n\n")
	flusher.Flush()

	ch := make(chan []byte, 16)
	s.mu.Lock()
	if s.sseClients == nil {
		s.mu.Unlock()
		return
	}
	s.sseClients[ch] = struct{}{}
	s.mu.Unlock()

	defer func() {
		s.mu.Lock()
		delete(s.sseClients, ch)
		s.mu.Unlock()
	}()

	notify := r.Context().Done()
	for {
		select {
		case <-notify:
			return
		case data, ok := <-ch:
			if !ok {
				return
			}
			_, _ = fmt.Fprintf(w, "data: %s\n\n", data)
			flusher.Flush()
		}
	}
}

func (s *Server) handleHeartbeat(w http.ResponseWriter, r *http.Request) {
	s.Lifecycle.OnHeartbeat()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleApply(w http.ResponseWriter, r *http.Request) {
	body, err := s.readJSONBody(r)
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	v := spec.Validate(body)
	if !v.OK {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"errors": v.Errors})
		return
	}
	if !s.Lifecycle.OnApply() {
		http.Error(w, "not in WAITING state", http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	go s.OnApply(spec.ApplyExclusions(body))
}

func (s *Server) handleReject(w http.ResponseWriter, r *http.Request) {
	// Critical race-fix mirroring the Node helper: send the response BEFORE
	// triggering the lifecycle terminal transition, so the response can flush
	// to the kernel's TCP buffer before any subsequent process exit.
	w.WriteHeader(http.StatusAccepted)
	if f, ok := w.(http.Flusher); ok {
		f.Flush()
	}
	go func() {
		// Brief grace before triggering the terminal — gives the kernel time
		// to flush. The 200ms global grace in main.go's exit path is the
		// belt-and-suspenders fallback.
		time.Sleep(50 * time.Millisecond)
		s.Lifecycle.OnReject()
	}()
}

func (s *Server) handleRetry(w http.ResponseWriter, r *http.Request) {
	body, err := s.readJSONBody(r)
	if err != nil {
		http.Error(w, "bad body", http.StatusBadRequest)
		return
	}
	v := spec.Validate(body)
	if !v.OK {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusBadRequest)
		_ = json.NewEncoder(w).Encode(map[string]interface{}{"errors": v.Errors})
		return
	}
	if !s.Lifecycle.OnRetry() {
		http.Error(w, "not retryable in current state", http.StatusConflict)
		return
	}
	w.WriteHeader(http.StatusAccepted)
	go s.OnApply(spec.ApplyExclusions(body))
}

func (s *Server) readJSONBody(r *http.Request) (*spec.Spec, error) {
	r.Body = http.MaxBytesReader(nil, r.Body, maxBodyBytes)
	defer r.Body.Close()
	bytes, err := io.ReadAll(r.Body)
	if err != nil {
		return nil, err
	}
	if !strings.HasPrefix(strings.TrimSpace(string(bytes)), "{") {
		return nil, fmt.Errorf("body is not JSON object")
	}
	var s_ spec.Spec
	if err := json.Unmarshal(bytes, &s_); err != nil {
		return nil, err
	}
	return &s_, nil
}
