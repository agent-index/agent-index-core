#!/usr/bin/env node
// show-plan.js — Permission-change helper main binary.
'use strict';

const fs = require('fs');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');
const readline = require('readline');
const path = require('path');

const { validate } = require('./validate');
const { Listener } = require('./listener');
const { EXIT_CODES } = require('./lifecycle');

function diag(msg) { process.stderr.write('[helper] ' + msg + '\n'); }
function emitFinal(report) { process.stdout.write(JSON.stringify(report) + '\n'); }
function usage(code) { diag('Usage: node show-plan.js <spec-file-path> [--cli]'); process.exit(code); }

function isWsl() {
  try {
    if (process.platform !== 'linux') return false;
    return /microsoft/i.test(fs.readFileSync('/proc/version', 'utf8'));
  } catch (e) { return false; }
}
function openBrowser(url) {
  const platform = process.platform;
  let cmd, args;
  if (platform === 'darwin') { cmd = 'open'; args = [url]; }
  else if (platform === 'win32') { cmd = 'cmd'; args = ['/c', 'start', '""', url]; }
  else if (isWsl()) {
    try { execSync('command -v wslview', { stdio: 'ignore' }); cmd = 'wslview'; args = [url]; }
    catch (e) { cmd = 'cmd.exe'; args = ['/c', 'start', url]; }
  } else { cmd = 'xdg-open'; args = [url]; }
  try { const c = spawn(cmd, args, { detached: true, stdio: 'ignore' }); c.unref(); return true; }
  catch (e) { return false; }
}

function summarizeForCli(spec) {
  const lines = [];
  lines.push('agent-index — permission change');
  lines.push('');
  lines.push('Purpose: ' + spec.context.purpose);
  lines.push('Requested by: ' + spec.context.requestor);
  if (spec.context.calling_task) lines.push('From task: ' + spec.context.calling_task);
  lines.push('');
  lines.push(spec.operations.length + ' operation' + (spec.operations.length === 1 ? '' : 's') + ':');
  spec.operations.forEach(function (op, i) {
    lines.push('  ' + (i + 1) + '. ' + op.op + '  ' + op.resource + '  →  ' + op.recipient + (op.role ? ' (' + op.role + ')' : ''));
  });
  return lines.join('\n');
}

async function runCli(spec) {
  process.stderr.write('\n' + summarizeForCli(spec) + '\n\n');
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  const answer = await new Promise(function (resolve) {
    rl.question('Apply these changes? [y/N] ', function (a) { rl.close(); resolve(a); });
  });
  if (!/^y(es)?$/i.test(answer.trim())) {
    emitFinal({ outcome: 'rejected', applied_operations: [], failed_operations: [] });
    process.exit(EXIT_CODES.REJECTED);
  }
  const applyScript = path.resolve(__dirname, 'apply.js');
  return new Promise(function (resolve) {
    const child = spawn('node', [applyScript], { stdio: ['pipe', 'pipe', 'inherit'] });
    let buf = '';
    let finalDone = null;
    child.stdin.write(JSON.stringify(spec));
    child.stdin.end();
    child.stdout.on('data', function (c) {
      buf += c.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        try {
          const ev = JSON.parse(line);
          const idx = (ev.op_index !== undefined && ev.op_index !== null) ? ev.op_index : '';
          if (ev.type === 'op_pending') process.stderr.write('  · op_' + idx + '\n');
          else if (ev.type === 'op_complete') process.stderr.write('  ✓ op_' + idx + '\n');
          else if (ev.type === 'op_failed') process.stderr.write('  ✗ op_' + idx + ': ' + ((ev.error && ev.error.message) || (ev.error && ev.error.code) || 'failed') + '\n');
          if (ev.type === 'done') finalDone = ev;
        } catch (e) {}
      }
    });
    child.on('exit', function (code) {
      const outcome = code === 0 ? 'applied' : code === 1 ? 'partial_failure' : 'apply_error';
      emitFinal({
        outcome: outcome,
        applied_operations: (finalDone && finalDone.successful) || [],
        failed_operations: (finalDone && finalDone.failed) || [],
        verified_post_state: (finalDone && finalDone.verified_post_state) || [],
        user_edits: null,
        error_detail: null,
      });
      resolve();
      process.exit(code === 0 ? EXIT_CODES.APPLIED : EXIT_CODES.APPLY_FAILED);
    });
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) usage(EXIT_CODES.VALIDATION_ERROR);
  const cli = args.includes('--cli');
  const specPath = args.find(function (a) { return !a.startsWith('--'); });
  if (!specPath) usage(EXIT_CODES.VALIDATION_ERROR);

  let spec;
  try { spec = JSON.parse(fs.readFileSync(specPath, 'utf8')); }
  catch (err) {
    diag('Could not read spec at ' + specPath + ': ' + err.message);
    emitFinal({ outcome: 'validation_error', error_detail: err.message });
    process.exit(EXIT_CODES.VALIDATION_ERROR);
  }

  const v = validate(spec);
  if (!v.ok) {
    diag('Spec validation failed:');
    v.errors.forEach(function (e) { diag('  - ' + e); });
    emitFinal({ outcome: 'validation_error', error_detail: v.errors.join('; ') });
    process.exit(EXIT_CODES.VALIDATION_ERROR);
  }

  if (cli) return runCli(spec);

  const token = crypto.randomUUID();
  const listener = new Listener({
    spec: spec,
    token: token,
    onTerminal: function (terminal) {
      emitFinal(terminal.statusReport);
      // 200ms delay so any in-flight HTTP response (notably the 202 from
      // /reject) has time to drain to the client before we terminate.
      setTimeout(function () { process.exit(terminal.exitCode); }, 200);
    },
  });

  let port;
  try { port = await listener.start(); }
  catch (err) {
    diag('Could not bind to localhost: ' + err.message + '. Try --cli.');
    emitFinal({ outcome: 'validation_error', error_detail: 'bind failed: ' + err.message });
    process.exit(EXIT_CODES.VALIDATION_ERROR);
  }

  const targetUrl = listener.url();
  const opened = openBrowser(targetUrl);
  if (!opened) {
    diag('Could not open browser automatically.');
    diag('Open this URL in your browser to review:');
    diag('  ' + targetUrl);
    diag('The listener is waiting for up to 10 minutes.');
  } else {
    diag('Opened review page: ' + targetUrl);
  }

  process.on('SIGINT', function () { listener.lifecycle.onSignal('SIGINT'); });
  process.on('SIGTERM', function () { listener.lifecycle.onSignal('SIGTERM'); });
}

main().catch(function (err) {
  diag('Unhandled: ' + (err.stack || err.message));
  emitFinal({ outcome: 'apply_error', error_detail: err.message });
  process.exit(EXIT_CODES.APPLY_FAILED);
});
