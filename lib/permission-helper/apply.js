#!/usr/bin/env node
// apply.js — Permission-change apply-script.
//
// Spawned by the listener as a child process. Reads spec from stdin (single
// JSON document), runs each op via aifs-exec.sh in the user's environment
// using their existing OAuth token, writes line-buffered JSON events to
// stdout. Exits with structured codes per the tech design.
//
// Spec format documented at:
//   /shared/projects/access-control/artifacts/permission-change-helper-tech-design.md

'use strict';

const { spawn } = require('child_process');
const path = require('path');

// ---- Output ----
// Always line-buffered JSON. No partial writes; no logging that would mix
// with the structured stream. Free-form diagnostics go to stderr instead.
function emit(event) {
  process.stdout.write(JSON.stringify({ ts: Date.now(), ...event }) + '\n');
}
function diag(msg) {
  process.stderr.write(`[apply] ${msg}\n`);
}

// ---- aifs-exec invocation ----
// Resolve aifs-exec.sh from the conventional install path (relative to the
// helper's runtime location). Override via AIFS_EXEC_PATH for testing.
function resolveAifsExec() {
  const env = process.env.AIFS_EXEC_PATH;
  if (env) return env;
  // Helper runtime path is mcp-servers/permission-helper/. The aifs-exec wrapper
  // lives at mcp-servers/filesystem/. Walk one up + one over.
  return path.resolve(__dirname, '..', 'filesystem', 'aifs-exec.sh');
}

function callAifs(toolName, args) {
  return new Promise((resolve) => {
    const aifs = resolveAifsExec();
    const child = spawn('bash', [aifs, toolName, JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => (stdout += d.toString()));
    child.stderr.on('data', (d) => (stderr += d.toString()));
    child.on('error', (err) => resolve({ ok: false, error: { code: 'SPAWN_ERROR', message: err.message } }));
    child.on('exit', (code) => {
      if (code !== 0) {
        resolve({ ok: false, error: { code: 'AIFS_EXEC_FAILED', exit_code: code, stderr } });
        return;
      }
      // aifs-exec stdout has a "[aifs] Proxy detected..." preamble line on
      // some installs; strip lines that start with [aifs] before parsing.
      const lines = stdout.split('\n').filter((l) => !l.startsWith('[aifs]'));
      try {
        const result = JSON.parse(lines.join('\n').trim() || '{}');
        if (result.error) {
          resolve({ ok: false, error: { code: result.error, message: result.message, path: result.path } });
        } else {
          resolve({ ok: true, result });
        }
      } catch (parseErr) {
        resolve({ ok: false, error: { code: 'PARSE_ERROR', message: parseErr.message, raw: stdout.slice(0, 500) } });
      }
    });
  });
}

// ---- Per-op logic ----

async function applyShare(op) {
  // Build args. `inherit` is optional (added in spec v1.1 / core 3.7.3).
  // When omitted, the adapter applies default semantics (inherit: true).
  // When false, the adapter applies override semantics — for gdrive that's
  // inheritedPermissionsDisabled: true on the file resource, requiring
  // organizer role on the Shared Drive (or owner on My Drive).
  const args = {
    path: op.resource,
    recipient: op.recipient,
    role: op.role,
  };
  if ('inherit' in op) {
    args.inherit = op.inherit;
  }
  return callAifs('aifs_share', args);
}

async function applyUnshare(op) {
  return callAifs('aifs_unshare', {
    path: op.resource,
    recipient: op.recipient,
  });
}

async function applyTransferOwnership(op) {
  return callAifs('aifs_transfer_ownership', {
    path: op.resource,
    new_owner: op.recipient,
  });
}

async function verifyPermissions(resource) {
  const result = await callAifs('aifs_get_permissions', { path: resource });
  if (!result.ok) return null;
  return result.result;
}

const APPLIERS = {
  share: applyShare,
  unshare: applyUnshare,
  transfer_ownership: applyTransferOwnership,
};

// ---- Main ----

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => (buf += chunk));
    process.stdin.on('end', () => resolve(buf));
    process.stdin.on('error', reject);
  });
}

async function main() {
  let spec;
  try {
    const raw = await readStdin();
    spec = JSON.parse(raw);
  } catch (err) {
    emit({ type: 'error', error: { code: 'BAD_SPEC', message: err.message } });
    process.exit(3);
  }

  if (!spec || !Array.isArray(spec.operations)) {
    emit({ type: 'error', error: { code: 'BAD_SPEC', message: 'spec.operations missing or not an array' } });
    process.exit(3);
  }

  const ops = spec.operations.filter((o) => !o.excluded);
  if (ops.length === 0) {
    emit({ type: 'done', successful: [], failed: [], verified_post_state: [] });
    process.exit(0);
  }

  const mode = spec.mode || 'fail_soft';
  const successful = [];
  const failed = [];
  const verified = [];

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const applier = APPLIERS[op.op];
    if (!applier) {
      const failureRow = { op_index: i, error: { code: 'UNKNOWN_OP', message: `unsupported op: ${op.op}` } };
      failed.push(failureRow);
      emit({ type: 'op_failed', op_index: i, error: failureRow.error });
      if (mode === 'all_or_nothing') break;
      continue;
    }

    emit({
      type: 'op_pending',
      op_index: i,
      op: op.op,
      resource: op.resource,
      recipient: op.recipient,
      role: op.role,
    });

    let result;
    try {
      result = await applier(op);
    } catch (err) {
      result = { ok: false, error: { code: 'APPLIER_THREW', message: err.message } };
    }

    if (!result.ok) {
      const failureRow = { op_index: i, error: result.error };
      failed.push(failureRow);
      emit({ type: 'op_failed', op_index: i, error: result.error });
      if (mode === 'all_or_nothing') {
        diag(`all_or_nothing: aborting after first failure at op_index ${i}`);
        break;
      }
      continue;
    }

    // Verify post-state via aifs_get_permissions.
    const postState = await verifyPermissions(op.resource);
    if (postState) {
      verified.push({ op_index: i, resource: op.resource, recipients: postState.recipients || [] });
    }

    successful.push(i);
    emit({ type: 'op_complete', op_index: i, verified_state: postState });
  }

  emit({ type: 'done', successful, failed, verified_post_state: verified });

  if (failed.length === 0) {
    process.exit(0);
  } else if (successful.length > 0) {
    process.exit(1); // partial failure
  } else {
    process.exit(2); // total failure
  }
}

main().catch((err) => {
  diag(`unhandled: ${err.stack || err.message}`);
  emit({ type: 'error', error: { code: 'INTERNAL', message: err.message } });
  process.exit(3);
});
