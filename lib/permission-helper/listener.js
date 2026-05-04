// listener.js — Ephemeral one-shot HTTP listener for the permission helper.
'use strict';

const http = require('http');
const url = require('url');
const path = require('path');
const { spawn } = require('child_process');
const { Lifecycle, EXIT_CODES } = require('./lifecycle');
const { render } = require('./template');
const { validate, applyExclusions } = require('./validate');

const APPLY_SCRIPT = path.resolve(__dirname, 'apply.js');

class Listener {
  constructor(options) {
    this.spec = options.spec;
    this.token = options.token;
    const externalCallback = options.onTerminal;
    const self = this;
    this.lifecycle = new Lifecycle({
      onTerminal: function (terminal) {
        self._handleTerminal(terminal, externalCallback);
      },
      timing: options.timing || {},
    });
    this.sseClients = new Set();
    this.applyChild = null;
    this.server = http.createServer(function (req, res) { self._handle(req, res); });
    this.server.on('error', function (err) {
      externalCallback({ state: 'ERROR_INTERNAL', exitCode: EXIT_CODES.VALIDATION_ERROR, statusReport: { outcome: 'apply_error', error_detail: 'server error: ' + err.message } });
    });
  }

  start() {
    const self = this;
    return new Promise(function (resolve, reject) {
      self.server.listen(0, '127.0.0.1', function () {
        self.port = self.server.address().port;
        self._sseKeepalive = setInterval(function () { self._broadcast({ type: 'keepalive' }); }, 15000);
        resolve(self.port);
      });
      self.server.once('error', reject);
    });
  }

  url() {
    return 'http://127.0.0.1:' + this.port + '/?token=' + encodeURIComponent(this.token);
  }

  shutdown() {
    if (this._sseKeepalive) clearInterval(this._sseKeepalive);
    for (const res of this.sseClients) { try { res.end(); } catch (e) {} }
    this.sseClients.clear();
    if (this.applyChild) {
      try {
        if (this.applyChild.exitCode === null && this.applyChild.signalCode === null) {
          this.applyChild.kill('SIGTERM');
        }
      } catch (e) {}
    }
    if (this.server) this.server.close();
  }

  _handle(req, res) {
    const parsed = url.parse(req.url, true);
    const tokenFromQuery = parsed.query && parsed.query.token;
    const tokenFromHeader = req.headers['x-session-token'];
    const token = tokenFromQuery || tokenFromHeader;
    if (token !== this.token) { res.writeHead(403); res.end('forbidden'); return; }
    const origin = req.headers.origin;
    if (origin && origin !== 'http://127.0.0.1:' + this.port && origin !== 'http://localhost:' + this.port) {
      res.writeHead(403); res.end('forbidden origin'); return;
    }
    try {
      if (req.method === 'GET' && parsed.pathname === '/') return this._handleIndex(req, res);
      if (req.method === 'GET' && parsed.pathname === '/events') return this._handleEvents(req, res);
      if (req.method === 'POST' && parsed.pathname === '/heartbeat') return this._handleHeartbeat(req, res);
      if (req.method === 'POST' && parsed.pathname === '/apply') return this._handleApply(req, res);
      if (req.method === 'POST' && parsed.pathname === '/reject') return this._handleReject(req, res);
      if (req.method === 'POST' && parsed.pathname === '/retry') return this._handleRetry(req, res);
      res.writeHead(404); res.end('not found');
    } catch (err) {
      res.writeHead(500); res.end('internal error');
    }
  }

  _handleIndex(req, res) {
    const html = render(this.spec, this.token);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
  }

  _handleEvents(req, res) {
    const self = this;
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
    });
    self.sseClients.add(res);
    req.on('close', function () { self.sseClients.delete(res); });
    self._send(res, { type: 'connected' });
  }

  _handleHeartbeat(req, res) {
    this.lifecycle.onHeartbeat();
    res.writeHead(204); res.end();
  }

  async _handleApply(req, res) {
    let body;
    try { body = await this._readJsonBody(req); }
    catch (e) { res.writeHead(400); res.end('bad body'); return; }
    const v = validate(body);
    if (!v.ok) { res.writeHead(400); res.end(JSON.stringify({ errors: v.errors })); return; }
    if (!this.lifecycle.onApply(body)) { res.writeHead(409); res.end('not in WAITING state'); return; }
    res.writeHead(202); res.end();
    this._spawnApply(applyExclusions(body));
  }

  _handleReject(req, res) {
    // Send the response BEFORE triggering the lifecycle terminal transition,
    // so the response can flush to the kernel's TCP buffer before any
    // subsequent process.exit (in show-plan.js's onTerminal handler).
    const self = this;
    res.writeHead(202);
    res.end('', function () {
      // After the response body has been flushed to the kernel, trigger
      // the terminal state. show-plan.js adds a 200ms grace before
      // process.exit so the kernel has time to send the packet.
      setImmediate(function () { self.lifecycle.onReject(); });
    });
  }

  async _handleRetry(req, res) {
    let body;
    try { body = await this._readJsonBody(req); }
    catch (e) { res.writeHead(400); res.end('bad body'); return; }
    const v = validate(body);
    if (!v.ok) { res.writeHead(400); res.end(JSON.stringify({ errors: v.errors })); return; }
    if (!this.lifecycle.onRetry(body)) { res.writeHead(409); res.end('not retryable in current state'); return; }
    res.writeHead(202); res.end();
    this._spawnApply(applyExclusions(body));
  }

  _spawnApply(spec) {
    const self = this;
    self.applyChild = spawn('node', [APPLY_SCRIPT], { stdio: ['pipe', 'pipe', 'inherit'] });
    self.applyChild.stdin.write(JSON.stringify(spec));
    self.applyChild.stdin.end();
    let buf = '';
    let finalDone = null;
    self.applyChild.stdout.on('data', function (chunk) {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { continue; }
        if (ev.type === 'done') finalDone = ev;
        self._broadcast(ev);
      }
    });
    self.applyChild.on('exit', function (exitCode) {
      self.applyChild = null;
      self.lifecycle.onApplyScriptExit(exitCode, finalDone);
    });
    self.applyChild.on('error', function (err) {
      self.applyChild = null;
      self.lifecycle.onApplyScriptExit(3, { error: { code: 'SPAWN_ERROR', message: err.message } });
    });
  }

  _broadcast(event) {
    const data = JSON.stringify(event);
    for (const res of this.sseClients) {
      try { this._send(res, event, data); } catch (e) {}
    }
  }
  _send(res, event, preEncoded) {
    const data = preEncoded || JSON.stringify(event);
    res.write('data: ' + data + '\n\n');
  }

  _readJsonBody(req) {
    return new Promise(function (resolve, reject) {
      let buf = '';
      req.setEncoding('utf8');
      req.on('data', function (c) {
        buf += c;
        if (buf.length > 1024 * 1024) { req.destroy(); reject(new Error('body too large')); }
      });
      req.on('end', function () {
        try { resolve(JSON.parse(buf)); } catch (e) { reject(e); }
      });
      req.on('error', reject);
    });
  }

  _handleTerminal(terminal, externalCallback) {
    this.shutdown();
    externalCallback(terminal);
  }
}

module.exports = { Listener };
