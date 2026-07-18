#!/usr/bin/env node
/*
 * build-permission-spec.js -- committed permission-spec builder (agent-index-core lib/permission-spec)
 * Level-3 tooling: the calling task emits ONLY a data ops-list; this committed CLI validates it,
 * enforces the op vocabulary + recipient form + canonical output path, and writes the spec the
 * permission-change-helper consumes. Kills the hand-authored-JSON bug class:
 *   - transferdocopname : op MUST be one of share|unshare|transfer_ownership (rejects "transfer")
 *   - recipidform       : recipient MUST be email-form (rejects bare GUIDs)
 *   - permspecscratchpad: spec ALWAYS written under <project-dir>/outputs/ (never the sandbox scratchpad)
 *
 * Usage:
 *   node build-permission-spec.js --project-dir <abs> --task <calling_task> --ops-file <ops.json>
 *   node build-permission-spec.js --project-dir <abs> --task <calling_task> --ops '<json-array>'
 *
 * ops.json / --ops : a JSON array of operation descriptors (PURE DATA -- what the agent produces):
 *   [ { "op":"share", "resource":"/shared/members/artifacts/<hash>/",
 *       "recipient":"user@example.com", "role":"writer", "before": <optional pre-state perms> },
 *     { "op":"unshare", "resource":"id:<fileId>", "recipient":"user@example.com" },
 *     { "op":"transfer_ownership", "resource":"id:<fileId>", "recipient":"newowner@example.com" } ]
 *
 * On success: writes <project-dir>/outputs/permission-plan-<ISO>.json and prints, on stdout, a JSON
 * object { spec_path, link_path, op_count, summary } so the caller uses the exact path (no guessing).
 * Exit 0 = wrote spec; 1 = validation error (nothing written); 2 = usage/IO error.
 */
const fs = require('fs');
const path = require('path');

const OPS = new Set(['share', 'unshare', 'transfer_ownership']);
const SHARE_ROLES = new Set(['reader', 'writer']);

function die(code, msg) { process.stderr.write('build-permission-spec: ' + msg + '\n'); process.exit(code); }

function parseArgs(argv) {
  const a = {};
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--project-dir') a.projectDir = argv[++i];
    else if (k === '--task') a.task = argv[++i];
    else if (k === '--ops-file') a.opsFile = argv[++i];
    else if (k === '--ops') a.opsInline = argv[++i];
    else die(2, 'unknown arg: ' + k);
  }
  return a;
}

const args = parseArgs(process.argv);
if (!args.projectDir) die(2, '--project-dir is required (abs path containing agent-index.json)');
if (!args.task) args.task = 'permission-change';
if (!fs.existsSync(args.projectDir)) die(2, 'project-dir does not exist: ' + args.projectDir);

let raw;
if (args.opsFile) { try { raw = fs.readFileSync(args.opsFile, 'utf8'); } catch (e) { die(2, 'cannot read ops-file: ' + e.message); } }
else if (args.opsInline) raw = args.opsInline;
else die(2, 'provide --ops-file <path> or --ops <json-array>');

let ops;
try { ops = JSON.parse(raw); } catch (e) { die(2, 'ops is not valid JSON: ' + e.message); }
if (!Array.isArray(ops)) die(1, 'ops must be a JSON array');
// An empty ops list is legitimate (e.g. onedrive invite where site membership makes grants no-ops).
// Signal it distinctly so the caller can skip surfacing a helper link.
const errors = [];
const clean = [];
ops.forEach((o, i) => {
  const at = 'ops[' + i + ']';
  if (!o || typeof o !== 'object') { errors.push(at + ': not an object'); return; }
  const op = o.op;
  if (!OPS.has(op)) { errors.push(at + '.op="' + op + '" invalid; must be one of ' + [...OPS].join('|') + ' (transferdocopname guard)'); return; }
  if (!o.resource || typeof o.resource !== 'string') { errors.push(at + '.resource is required'); return; }
  const rcpt = o.recipient;
  if (!rcpt || typeof rcpt !== 'string') { errors.push(at + '.recipient is required'); return; }
  // recipient must be email-form (has @), not a bare GUID (recipidform)
  const guidRe = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
  if (guidRe.test(rcpt) || rcpt.indexOf('@') === -1) { errors.push(at + '.recipient must be email/UPN form, not a bare objectId (recipidform): ' + rcpt); return; }
  const entry = { op, resource: o.resource, recipient: rcpt };
  if (op === 'share') {
    if (!SHARE_ROLES.has(o.role)) { errors.push(at + '.role must be reader|writer for a share op'); return; }
    entry.role = o.role;
  } else if (op === 'transfer_ownership') {
    entry.role = 'owner';
  } // unshare: no role
  if (o.before !== undefined) entry.before = o.before;
  // optional passthroughs for collaborative-ACL ops (install-collection): inherit/restrict
  if (o.inherit !== undefined) entry.inherit = o.inherit;
  if (o.restrict !== undefined) entry.restrict = o.restrict;
  clean.push(entry);
});
if (errors.length) die(1, 'validation failed:\n  - ' + errors.join('\n  - '));

const spec = { version: '1.0', task: args.task, operations: clean };
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const outDir = path.join(args.projectDir, 'outputs');
try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) { die(2, 'cannot create outputs dir: ' + e.message); }
const specPath = path.join(outDir, 'permission-plan-' + ts + '.json');
try { fs.writeFileSync(specPath, JSON.stringify(spec, null, 2) + '\n', 'utf8'); } catch (e) { die(2, 'cannot write spec: ' + e.message); }

const summary = clean.length === 0 ? 'no operations (all grants already held / no-op)'
  : clean.map(o => o.op + ' ' + (o.role ? o.role + ' ' : '') + o.recipient + ' on ' + o.resource).join('; ');
process.stdout.write(JSON.stringify({
  spec_path: specPath,
  link_path: 'outputs/' + path.basename(specPath),
  op_count: clean.length,
  summary
}, null, 2) + '\n');
process.exit(0);
