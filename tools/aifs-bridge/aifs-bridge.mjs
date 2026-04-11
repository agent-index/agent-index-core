#!/usr/bin/env node

/**
 * aifs-bridge — HTTP daemon that manages a long-lived MCP server subprocess.
 *
 * Problem: Cowork's plugin system can kill the MCP server process mid-session,
 * dropping the aifs_* tools. This bridge runs the same server bundle as a
 * child process under Claude's control, auto-restarts it on crash, and
 * exposes tool calls over a localhost HTTP interface.
 *
 * Usage:
 *   node aifs-bridge.mjs [--port PORT] [--config PATH_TO_AGENT_INDEX_JSON]
 *   node aifs-bridge.mjs [--port PORT] [--bundle PATH_TO_SERVER_BUNDLE] [--env KEY=VALUE ...]
 *
 * Claude then calls tools with:
 *   curl -s http://localhost:PORT/call -d '{"tool":"aifs_read","args":{"path":"/foo"}}'
 *
 * Endpoints:
 *   POST /call     — call a tool: { tool, args }
 *   GET  /health   — check bridge + server status
 *   GET  /tools    — list available tools
 *   POST /restart  — force restart the MCP server
 *   POST /shutdown — gracefully shut down
 */

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createInterface } from 'node:readline';

// --- Configuration ---

const args = process.argv.slice(2);
let port = 7819;
let configPath = null;
let directBundlePath = null;
let extraEnv = {};

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--port' && args[i + 1]) { port = parseInt(args[i + 1], 10); i++; }
  else if (args[i] === '--config' && args[i + 1]) { configPath = args[i + 1]; i++; }
  else if (args[i] === '--bundle' && args[i + 1]) { directBundlePath = args[i + 1]; i++; }
  else if (args[i] === '--env' && args[i + 1]) {
    const [k, ...v] = args[i + 1].split('=');
    extraEnv[k] = v.join('=');
    i++;
  }
}

// --- Resolve bundle path ---
// Two modes:
//   1. --bundle: direct path to any MCP server bundle (generic mode)
//   2. --config or auto-discover: reads agent-index.json to find the bundle (agent-index mode)

let bundlePath;

if (directBundlePath) {
  // Generic mode: any MCP server
  bundlePath = resolve(directBundlePath);
  if (!existsSync(bundlePath)) {
    console.error(`[aifs-bridge] Server bundle not found: ${bundlePath}`);
    process.exit(1);
  }
  // If config was also provided, use it for AIFS_CONFIG_PATH env var
  if (configPath) {
    extraEnv.AIFS_CONFIG_PATH = resolve(configPath);
  }
} else {
  // Agent-index mode: discover config and derive bundle path
  if (!configPath) {
    configPath = process.env.AIFS_CONFIG_PATH;
  }
  if (!configPath) {
    // Scan Cowork mounts
    const homeDir = process.env.HOME || '/root';
    const { readdirSync } = await import('node:fs');
    const mntDir = `${homeDir}/mnt`;
    if (existsSync(mntDir)) {
      for (const name of readdirSync(mntDir)) {
        const candidate = `${mntDir}/${name}/agent-index.json`;
        if (existsSync(candidate)) {
          configPath = candidate;
          break;
        }
      }
    }
  }

  if (!configPath || !existsSync(configPath)) {
    console.error('[aifs-bridge] Cannot find agent-index.json. Use --config, --bundle, or set AIFS_CONFIG_PATH.');
    process.exit(1);
  }

  const config = JSON.parse(readFileSync(configPath, 'utf-8'));
  const projectDir = dirname(resolve(configPath));
  const bundleRel = config.remote_filesystem?.mcp_server?.bundle_path || 'mcp-servers/filesystem/server.bundle.js';
  bundlePath = resolve(projectDir, bundleRel);

  if (!existsSync(bundlePath)) {
    console.error(`[aifs-bridge] Server bundle not found: ${bundlePath}`);
    process.exit(1);
  }

  extraEnv.AIFS_CONFIG_PATH = resolve(configPath);
}

if (configPath) console.error(`[aifs-bridge] Config: ${resolve(configPath)}`);
console.error(`[aifs-bridge] Bundle: ${bundlePath}`);
if (Object.keys(extraEnv).length) console.error(`[aifs-bridge] Extra env: ${Object.keys(extraEnv).join(', ')}`);

// --- MCP Server Process Management ---

let serverProcess = null;
let serverReady = false;
let serverReadyPromise = null;
let messageId = 0;
let pendingRequests = new Map(); // id -> { resolve, reject, timer }
let restartCount = 0;
let lastStartTime = 0;

/** Buffer for incomplete lines from server stdout */
let stdoutBuffer = '';

function spawnServer() {
  if (serverProcess) {
    try { serverProcess.kill(); } catch (_) {}
  }

  serverReady = false;
  const startTime = Date.now();
  lastStartTime = startTime;

  console.error(`[aifs-bridge] Starting MCP server (attempt ${restartCount + 1})...`);

  serverProcess = spawn('node', [bundlePath], {
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  // Parse newline-delimited JSON-RPC from stdout
  serverProcess.stdout.on('data', (chunk) => {
    stdoutBuffer += chunk.toString();
    const lines = stdoutBuffer.split('\n');
    stdoutBuffer = lines.pop(); // Keep incomplete last line in buffer

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const msg = JSON.parse(trimmed);
        handleServerMessage(msg);
      } catch (e) {
        // Not JSON — probably a log line, forward to stderr
        console.error(`[aifs-server] ${trimmed}`);
      }
    }
  });

  serverProcess.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (text) console.error(`[aifs-server] ${text}`);
  });

  serverProcess.on('exit', (code, signal) => {
    console.error(`[aifs-bridge] Server exited (code=${code}, signal=${signal})`);
    serverProcess = null;
    serverReady = false;

    // Reject all pending requests
    for (const [id, pending] of pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(`Server exited during request (code=${code})`));
    }
    pendingRequests.clear();
  });

  serverProcess.on('error', (err) => {
    console.error(`[aifs-bridge] Server spawn error: ${err.message}`);
    serverProcess = null;
    serverReady = false;
  });

  // Do MCP initialization handshake
  serverReadyPromise = doHandshake();
  restartCount++;

  return serverReadyPromise;
}

async function doHandshake() {
  // Send initialize request
  const initResult = await sendRpc('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'aifs-bridge', version: '1.0.0' },
  });

  // Send initialized notification (no id = notification)
  sendNotification('notifications/initialized', {});
  serverReady = true;
  console.error(`[aifs-bridge] MCP handshake complete. Server ready.`);
  return initResult;
}

function sendRpc(method, params) {
  return new Promise((resolve, reject) => {
    if (!serverProcess || !serverProcess.stdin.writable) {
      return reject(new Error('Server not running'));
    }

    const id = ++messageId;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params });

    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`RPC timeout for ${method} (id=${id})`));
    }, 30000);

    pendingRequests.set(id, { resolve, reject, timer });
    serverProcess.stdin.write(msg + '\n');
  });
}

function sendNotification(method, params) {
  if (!serverProcess || !serverProcess.stdin.writable) return;
  const msg = JSON.stringify({ jsonrpc: '2.0', method, params });
  serverProcess.stdin.write(msg + '\n');
}

function handleServerMessage(msg) {
  if (msg.id != null && pendingRequests.has(msg.id)) {
    const pending = pendingRequests.get(msg.id);
    pendingRequests.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
    } else {
      pending.resolve(msg.result);
    }
  }
  // Ignore notifications from server for now
}

async function ensureServer() {
  if (serverReady && serverProcess && !serverProcess.killed) {
    return;
  }
  await spawnServer();
}

// --- HTTP Server ---

const httpServer = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const path = url.pathname;

  // CORS headers for flexibility
  res.setHeader('Content-Type', 'application/json');

  try {
    if (path === '/health' && req.method === 'GET') {
      res.end(JSON.stringify({
        bridge: 'ok',
        server: serverReady && serverProcess && !serverProcess.killed ? 'running' : 'stopped',
        restartCount,
        pid: serverProcess?.pid || null,
      }));
      return;
    }

    if (path === '/tools' && req.method === 'GET') {
      await ensureServer();
      const result = await sendRpc('tools/list', {});
      res.end(JSON.stringify(result));
      return;
    }

    if (path === '/call' && req.method === 'POST') {
      const body = await readBody(req);
      const { tool, args } = JSON.parse(body);

      if (!tool) {
        res.statusCode = 400;
        res.end(JSON.stringify({ error: 'Missing "tool" field' }));
        return;
      }

      await ensureServer();
      const result = await sendRpc('tools/call', {
        name: tool,
        arguments: args || {},
      });
      res.end(JSON.stringify(result));
      return;
    }

    if (path === '/restart' && req.method === 'POST') {
      await spawnServer();
      res.end(JSON.stringify({ status: 'restarted', pid: serverProcess?.pid }));
      return;
    }

    if (path === '/shutdown' && req.method === 'POST') {
      res.end(JSON.stringify({ status: 'shutting_down' }));
      if (serverProcess) {
        serverProcess.kill();
      }
      httpServer.close();
      process.exit(0);
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'Not found', endpoints: ['/call', '/health', '/tools', '/restart', '/shutdown'] }));
  } catch (err) {
    console.error(`[aifs-bridge] Request error: ${err.message}`);
    res.statusCode = 500;
    res.end(JSON.stringify({ error: err.message }));
  }
});

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// --- Start ---

// Pre-spawn the server so it's ready for the first request
spawnServer().then(() => {
  httpServer.listen(port, '127.0.0.1', () => {
    // Print the ready signal to stdout (not stderr) so callers can detect it
    console.log(JSON.stringify({ ready: true, port, pid: process.pid }));
    console.error(`[aifs-bridge] Listening on http://127.0.0.1:${port}`);
  });
}).catch((err) => {
  console.error(`[aifs-bridge] Fatal: ${err.message}`);
  process.exit(1);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.error('[aifs-bridge] SIGTERM received, shutting down...');
  if (serverProcess) serverProcess.kill();
  httpServer.close();
  process.exit(0);
});

process.on('SIGINT', () => {
  console.error('[aifs-bridge] SIGINT received, shutting down...');
  if (serverProcess) serverProcess.kill();
  httpServer.close();
  process.exit(0);
});
