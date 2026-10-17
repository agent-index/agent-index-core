#!/usr/bin/env node
/*
 * permission-changes.js -- committed Level-3 tooling for the core permission-changes procedure
 * (agent-index-core lib/permission-changes; normative model: runtime-reference.md § "Permission changes:
 * list, confirm, apply, verify"; procedure: internal/permission-changes.md).
 *
 * PURE DATA. This script never calls the backend. The agent makes every aifs_* call and handles
 * the confirmation turn; this script does the mechanical parts so they are identical every run:
 *
 *   plan    changes[] + current permissions + org identities  ->  rows (no-ops, outside-org,
 *           high-impact, backend notes, unsupported) + the exact table to show + the prompt
 *   verify  planned rows + confirmation + apply results + post-state  ->  final state per row
 *           + run_result (+ revert offer for all_or_nothing)
 *   record  a finished run  ->  one JSONL line for members/{hash}/state/permission-changes.jsonl
 *
 * Usage:
 *   node permission-changes.js <plan|verify|record> [--input <file.json>] [--dry-run]
 *   (input JSON is read from --input, else stdin; output JSON is written to stdout)
 *
 * Exit codes: 0 ok; 2 invalid input or usage (nothing partial is ever emitted on exit 2 -- stdout
 * carries {ok:false, errors[]} only).
 *
 * There is deliberately NO `source` value for content the agent read (documents, messages, file
 * bodies, tool output). A change that cannot name one of SOURCES is rejected. This is the
 * structural form of the declared-sources trust rule.
 */
'use strict';

const OPS = ['share', 'unshare', 'transfer_ownership'];
const SHARE_ROLES = ['reader', 'commenter', 'writer'];
const SOURCES = ['task_spec', 'collaborative_acls', 'org_config', 'member_request', 'current_state'];
const CONFIRMERS = ['admin', 'owner', 'collection_admin'];
const MODES = ['independent', 'all_or_nothing'];
const BACKENDS = ['gdrive', 'onedrive', 's3'];
const RANK = { none: 0, reader: 1, commenter: 2, writer: 3, owner: 4 };
const VERBS = { reader: 'read', commenter: 'comment on', writer: 'edit' };

const lc = (s) => (typeof s === 'string' ? s.trim().toLowerCase() : s);
const rank = (role) => (role in RANK ? RANK[role] : 0);

class InputError extends Error {
  constructor(errors) { super(errors.join('; ')); this.errors = errors; }
}

// ---------------------------------------------------------------- validation

function validatePlanInput(input) {
  const e = [];
  if (!input || typeof input !== 'object') throw new InputError(['input must be a JSON object']);
  if (typeof input.calling_task !== 'string' || !input.calling_task) e.push('calling_task is required');
  if (typeof input.purpose !== 'string' || !input.purpose) e.push('purpose is required');
  if (!CONFIRMERS.includes(input.confirmer)) e.push(`confirmer must be one of ${CONFIRMERS.join('|')}`);
  const mode = input.mode === undefined ? 'independent' : input.mode;
  if (!MODES.includes(mode)) e.push(`mode must be one of ${MODES.join('|')}`);
  const org = input.org || {};
  if (!BACKENDS.includes(org.backend)) e.push(`org.backend must be one of ${BACKENDS.join('|')}`);
  if (!Array.isArray(org.member_identities)) e.push('org.member_identities must be an array');
  if (typeof org.all_members_group !== 'string' || !org.all_members_group.includes('@')) e.push('org.all_members_group must be a group address');
  if (!Array.isArray(input.changes) || input.changes.length === 0) e.push('changes must be a non-empty array');
  else input.changes.forEach((c, i) => validateChange(c, i + 1, e));
  if (e.length) throw new InputError(e);
  return mode;
}

function validateChange(c, n, e) {
  const p = `changes[${n}]`;
  if (!c || typeof c !== 'object') { e.push(`${p} must be an object`); return; }
  if (!OPS.includes(c.op)) e.push(`${p}.op must be one of ${OPS.join('|')}`);
  if (!SOURCES.includes(c.source)) {
    e.push(`${p}.source must be one of ${SOURCES.join('|')} (a change derived from content the agent read cannot be proposed)`);
  }
  if (typeof c.resource !== 'string' || !(c.resource.startsWith('/') || c.resource.startsWith('id:'))) {
    e.push(`${p}.resource must be an absolute path or id:{itemId}`);
  } else if (c.resource.startsWith('id:') && c.resource.slice(3).includes('/')) {
    e.push(`${p}.resource composite id:{folder}/{name} form is not allowed; use the item's own id:{itemId}`);
  } else if (c.resource === 'id:') {
    e.push(`${p}.resource id: is empty`);
  }
  if (typeof c.recipient !== 'string' || !c.recipient.includes('@')) e.push(`${p}.recipient must be an email or group address`);
  if (c.op === 'share') {
    if (!SHARE_ROLES.includes(c.role)) e.push(`${p}.role must be one of ${SHARE_ROLES.join('|')}`);
    if (c.inherit !== undefined && typeof c.inherit !== 'boolean') e.push(`${p}.inherit must be boolean`);
  } else {
    if (c.role !== undefined && c.role !== null) e.push(`${p}.role is only valid for share`);
    if (c.inherit !== undefined && c.inherit !== true) e.push(`${p}.inherit is only valid for share`);
  }
  if (c.reason !== undefined && (typeof c.reason !== 'string' || !c.reason)) e.push(`${p}.reason must be a non-empty string when given (omit it to use the run's purpose)`);
}

// ---------------------------------------------------------------- state helpers

function permsOf(current, resource) {
  const entry = current && current[resource];
  if (!entry) return null;
  return Array.isArray(entry.permissions) ? entry.permissions : [];
}

function ownerOf(entry) {
  if (!entry) return null;
  if (typeof entry.owner === 'string' && entry.owner) return lc(entry.owner);
  const p = (entry.permissions || []).find((x) => x.role === 'owner');
  return p ? lc(p.subject) : null;
}

// Best access a subject holds on a resource: {role, via} where via is 'direct' | 'inherited:{path}'.
function bestAccess(perms, subject) {
  let best = { role: 'none', via: null };
  for (const p of perms) {
    if (lc(p.subject) !== lc(subject)) continue;
    if (rank(p.role) > rank(best.role)) best = { role: p.role, via: p.inherited_from ? `inherited:${p.inherited_from}` : 'direct' };
  }
  return best;
}

function explicitGrant(perms, subject) {
  return perms.find((p) => lc(p.subject) === lc(subject) && !p.inherited_from) || null;
}

function viaText(via) {
  if (!via) return '';
  if (via === 'direct') return '';
  if (via.startsWith('inherited:')) return ` (inherited from ${via.slice(10)})`;
  if (via.startsWith('group:')) return ` (via ${via.slice(6)})`;
  return '';
}

// ---------------------------------------------------------------- plan

function plan(input) {
  const mode = validatePlanInput(input);
  const org = input.org;
  const group = lc(org.all_members_group);
  const members = new Set(org.member_identities.map(lc));
  const current = input.current || {};
  const missing = [...new Set(input.changes.map((c) => c.resource))].filter((r) => permsOf(current, r) === null);
  if (missing.length) throw new InputError(missing.map((r) => `current state missing for resource ${r} (read aifs_get_permissions first)`));

  const rows = input.changes.map((c, i) => {
    const perms = permsOf(current, c.resource);
    const recipient = lc(c.recipient);
    const isGroup = recipient === group;
    const row = {
      row: i + 1,
      op: c.op,
      resource: c.resource,
      resource_label: c.resource_label || c.resource,
      is_folder: c.is_folder === true || (c.resource.startsWith('/') && c.resource.endsWith('/')),
      recipient: c.recipient,
      recipient_label: isGroup ? `All members (${c.recipient})` : c.recipient,
      role: c.op === 'share' ? c.role : null,
      inherit: c.op === 'share' ? c.inherit !== false : true,
      reason: c.reason || input.purpose,
      source: c.source,
      before: 'none',
      before_via: null,
      after: null,
      noop: false,
      noop_reason: null,
      excess_access: false,
      outside_org: !isGroup && !members.has(recipient),
      high_impact: false,
      backend_note: null,
      unsupported: false,
      state: 'proposed',
    };

    if (c.op === 'share') {
      let acc = bestAccess(perms, recipient);
      // An org member also holds whatever the all-members group holds on this resource.
      if (!isGroup && members.has(recipient)) {
        const g = bestAccess(perms, group);
        if (rank(g.role) > rank(acc.role)) acc = { role: g.role, via: `group:${org.all_members_group}` };
      }
      row.before = acc.role;
      row.before_via = acc.via;
      row.after = rank(acc.role) >= rank(c.role) ? acc.role : c.role;
      if (row.inherit === false) {
        if (org.backend === 'onedrive') {
          row.backend_note = 'additive; parent access unchanged (OneDrive never breaks inheritance)';
        } else {
          row.high_impact = true;
          row.backend_note = 'removes inherited access on this item (needs organizer on a Shared Drive, owner on My Drive)';
        }
      }
      const inheritedPresent = perms.some((p) => p.inherited_from);
      const explicit = explicitGrant(perms, recipient);
      if (row.inherit === false && org.backend !== 'onedrive') {
        if (explicit && rank(explicit.role) >= rank(c.role) && !inheritedPresent) {
          row.noop = true; row.noop_reason = 'already in effect';
        }
      } else if (rank(acc.role) >= rank(c.role)) {
        row.noop = true;
        row.noop_reason = `already has ${acc.role}${viaText(acc.via)}`;
        // Finding 65: a task-spec grant (e.g. a collection code dir's reader row) already exceeded.
        // Still a no-op (the procedure never removes access it wasn't asked to), but say so visibly.
        if (c.source === 'task_spec' && acc.role !== 'owner' && rank(acc.role) > rank(c.role)) {
          row.excess_access = true;
          row.noop_reason += ` — more than this needs (${c.role})`;
        }
      }
      if (org.backend === 'onedrive' && row.outside_org && !row.noop && !row.backend_note) {
        // Findings 72/75: Microsoft 365 grants only to people its sharing settings allow.
        row.backend_note = 'Microsoft emails them an invitation to open it; this works only if your tenant\'s sharing settings allow sharing outside the org';
      }
    } else if (c.op === 'unshare') {
      row.high_impact = true;
      const explicit = explicitGrant(perms, recipient);
      const acc = bestAccess(perms, recipient);
      row.before = acc.role;
      row.before_via = acc.via;
      row.after = 'none';
      if (!explicit) {
        row.noop = true;
        row.noop_reason = acc.role === 'none'
          ? 'has no access to remove'
          : `access is inherited from ${acc.via.slice(10)} and can't be removed here`;
        row.after = acc.role;
      }
    } else if (c.op === 'transfer_ownership') {
      row.high_impact = true;
      const entry = current[c.resource];
      const owner = ownerOf(entry);
      row.before = owner ? `owner: ${owner}` : 'owner: unknown';
      row.after = `owner: ${c.recipient}`;
      const location = entry && entry.location;
      if (org.backend !== 'gdrive' || location === 'shared_drive') {
        row.unsupported = true;
        row.backend_note = org.backend !== 'gdrive'
          ? `ownership transfer is not available on ${org.backend}`
          : 'ownership transfer is not available on a Shared Drive (the drive owns its items)';
      } else if (owner && owner === recipient) {
        row.noop = true; row.noop_reason = 'already the owner';
      } else {
        row.backend_note = 'the new owner must accept the transfer from Google Drive\'s email';
      }
    }

    if (row.unsupported) row.state = 'unsupported';
    else if (row.noop) row.state = 'skipped_noop';
    return row;
  });

  const actionable = rows.filter((r) => r.state === 'proposed');
  return {
    ok: true,
    calling_task: input.calling_task,
    purpose: input.purpose,
    confirmer: input.confirmer,
    mode,
    backend: org.backend,
    rows,
    nothing_to_change: actionable.length === 0,
    standard_rows: actionable.filter((r) => !r.high_impact).map((r) => r.row),
    high_impact_rows: actionable.filter((r) => r.high_impact).map((r) => r.row),
    consequence_lines: actionable.map(consequence),
    table_markdown: renderTable(rows, input.purpose),
    confirmation_prompt: actionable.length === 0
      ? null
      : (actionable.some((r) => !r.high_impact)
        ? 'Reply **confirm** to apply, or tell me which to leave out. Nothing has changed yet.'
        : 'Nothing has changed yet. I\'ll ask you about each change below one at a time.'),
  };
}

function describeRole(role) { return role === 'none' ? 'none' : role; }

function nowCell(r) {
  if (r.op === 'transfer_ownership') return r.before;
  return describeRole(r.before) + viaText(r.before_via);
}

function afterCell(r) {
  if (r.op === 'transfer_ownership') return r.after;
  if (r.op === 'unshare') return r.noop ? describeRole(r.after) : '**none**';
  return `**${r.after}**${r.inherit === false ? ' (inheritance off)' : ''}`;
}

function whoCell(r) {
  return r.outside_org ? `${r.recipient_label} — **outside your org**` : r.recipient_label;
}

function opWord(r) {
  return { share: 'Share', unshare: 'Remove access', transfer_ownership: 'Transfer ownership' }[r.op];
}

function rowLine(r, statusOverride) {
  const why = statusOverride || r.reason + (r.backend_note ? ` — ${r.backend_note}` : '');
  return `| ${r.row} | ${opWord(r)} | ${r.resource_label} | ${whoCell(r)} | ${nowCell(r)} | ${afterCell(r)} | ${why} |`;
}

function renderTable(rows, purpose) {
  const head = '| # | Change | Resource | Who | Now | After | Why |\n|---|---|---|---|---|---|---|';
  const standard = rows.filter((r) => r.state === 'proposed' && !r.high_impact);
  const high = rows.filter((r) => r.state === 'proposed' && r.high_impact);
  const skipped = rows.filter((r) => r.state === 'skipped_noop' || r.state === 'unsupported');
  const out = [`**${purpose}**`, ''];
  if (standard.length) out.push(head, ...standard.map((r) => rowLine(r)), '');
  if (high.length) {
    out.push('**Needs individual confirmation:**', '', head, ...high.map((r) => rowLine(r)), '');
  }
  if (skipped.length) {
    out.push('**Not changing:**', '', head,
      ...skipped.map((r) => rowLine(r, r.state === 'unsupported' ? `not available — ${r.backend_note}` : `skipped — ${r.noop_reason}`)), '');
  }
  if (!standard.length && !high.length) out.push('Nothing to change — everything is already in effect.');
  return out.join('\n').trim();
}

function consequence(r) {
  const who = r.recipient === r.recipient_label ? r.recipient : r.recipient_label.replace(/ \(.*\)$/, '');
  const inside = r.is_folder ? ' and everything inside it' : '';
  if (r.op === 'share') {
    const ext = r.outside_org ? ' (outside your org)' : '';
    let s = `${who}${ext} will be able to ${VERBS[r.role]} ${r.resource_label}${inside}.`;
    if (r.inherit === false && r.high_impact) s += ' Anyone who only had access through the parent folder will lose access to this item.';
    return s;
  }
  if (r.op === 'unshare') return `${who} will no longer have direct access to ${r.resource_label}${inside}.`;
  return `${who} will become the owner of ${r.resource_label} once they accept Google Drive's transfer email; you'll keep edit access.`;
}

// ---------------------------------------------------------------- verify

const REASONS = {
  ACCESS_DENIED: 'you don\'t have the rights needed to change access on this item',
  INVALID_RECIPIENT: 'that address isn\'t a valid account or group',
  INVALID_SUBJECT: 'that address isn\'t a valid account or group',
  PATH_NOT_FOUND: 'the item couldn\'t be found (it may have been moved or deleted)',
  NOT_IMPLEMENTED: 'this change isn\'t available on this storage backend',
  NOT_AUTHENTICATED: 'your storage sign-in has expired — reconnect and try again',
  RATE_LIMITED: 'the storage service is rate-limiting requests — try again shortly',
  NOT_APPLIED_BY_ASSISTANT: 'the assistant didn\'t make this change — follow the manual step to make it yourself',
};

// Findings 72/75: the backend's sharing policy refused a recipient outside the org.
// onedrive adapter 2.7.1 reports EXTERNAL_SHARE_BLOCKED with Graph's own text in `reason`.
const POLICY_CODES = ['EXTERNAL_SHARE_BLOCKED', 'EXTERNAL_SHARE_UNSUPPORTED', 'POLICY_DENIED', 'SHARING_POLICY_DENIED'];
// Finding 84: the backend's own text names a sharing policy. When it doesn't (Graph's generic
// 400 sharingFailed "There was a problem sharing, please try again later."), the adapter's
// EXTERNAL_SHARE_BLOCKED is an inference, so the wording says "usually", not "your settings don't allow".
const POLICY_TEXT = /shar(e|ing)[^.]*(disabled|not allowed|blocked|restricted|turned off|prohibited)|external[ -]sharing|outside (of )?(your|the) (organi[sz]ation|org|domain|tenant)|polic(y|ies)|guest/i;

function plainReason(err, row, backend) {
  const code = err && err.code;
  const msg = (err && err.message) || '';
  if (row.op === 'share' && row.inherit === false && (code === 'ACCESS_DENIED' || /organizer/i.test(msg))) {
    return 'turning off inherited access needs organizer rights on this Shared Drive (or owner on My Drive); nothing was changed';
  }
  if (code && POLICY_CODES.includes(code)) {
    const suite = backend === 'onedrive' ? 'Microsoft 365' : (backend === 'gdrive' ? 'Google Workspace' : 'storage');
    // The backend's own text: `reason`. An adapter that maps a Graph error (graph_code/graph_status
    // set) puts its own canned sentence in `message`, so that is never treated as the backend's text.
    const fromGraph = !!(err && (err.graph_code || (err.graph_status !== undefined && err.graph_status !== null)));
    const why = (err && err.reason) || (fromGraph ? '' : msg);
    // onedrive 2.7.1+ says whether the policy was named (policy_inferred false) or inferred (true).
    const named = err.policy_inferred === false || (err.policy_inferred !== true && POLICY_TEXT.test(why));
    if (named) {
      return `your ${suite} sharing settings don't allow sharing with people outside the org (the backend said: ${why})`;
    }
    const vendor = backend === 'onedrive' ? 'Microsoft' : (backend === 'gdrive' ? 'Google' : 'The storage service');
    const where = backend === 'onedrive'
      ? "the tenant's external-sharing setting (SharePoint admin center → Policies → Sharing)"
      : (backend === 'gdrive' ? "the domain's external-sharing setting (Google Admin → Drive sharing)" : 'the org\'s external-sharing setting');
    const said = [err && err.graph_code, why].filter(Boolean).join(': ');
    return `${vendor} refused to share outside the org — usually ${where}${said ? ` (the backend said: ${said})` : ''}`;
  }
  if (code === 'INVALID_SUBJECT' && backend === 'onedrive' && row.outside_org) {
    return `${REASONS.INVALID_SUBJECT} in your Microsoft 365 tenant — they must be added to the tenant first (a guest account counts), then shared with by their tenant address`;
  }
  if (code && REASONS[code]) return REASONS[code];
  return msg ? `the storage service returned an error: ${msg}` : 'the storage service returned an unknown error';
}

function verify(input) {
  const e = [];
  if (!input || typeof input !== 'object') throw new InputError(['input must be a JSON object']);
  const p = input.plan;
  if (!p || !Array.isArray(p.rows)) e.push('plan (the output of `plan`) is required');
  const conf = input.confirmation || {};
  if (!['all', 'none'].includes(conf.standard)) e.push('confirmation.standard must be all|none');
  if (e.length) throw new InputError(e);

  const declined = new Set((conf.declined_rows || []).map(Number));
  const highOk = new Set((conf.high_impact_confirmed || []).map(Number));
  const applyResults = input.apply_results || {};
  const post = input.post || {};
  const mode = p.mode || 'independent';

  const isConfirmed = (r) => (r.high_impact ? highOk.has(r.row) : (conf.standard === 'all' && !declined.has(r.row))) && !declined.has(r.row);
  // all_or_nothing: declining ANY proposed row means nothing is applied (a half-confirmed atomic set
  // is not a confirmation of the set).
  const aonDeclined = mode === 'all_or_nothing' && p.rows.some((r) => r.state === 'proposed' && !isConfirmed(r));
  const rows = p.rows.map((r0) => {
    const r = { ...r0, error: null, permission_id: null, reason_text: null };
    if (r.state === 'skipped_noop' || r.state === 'unsupported') return r;
    if (aonDeclined || !isConfirmed(r)) { r.state = 'declined'; return r; }
    const res = applyResults[String(r.row)];
    if (!res) { r.state = 'not_attempted'; return r; }
    if (res.ok === false) {
      r.state = 'failed';
      r.error = res.error || null;
      r.reason_text = plainReason(res.error, r, p.backend);
      // inherit:false half-state: inheritance went off but the grant failed -> more restricted than intended.
      const pp = permsOf(post, r.resource);
      if (r.op === 'share' && r.inherit === false && pp && !pp.some((x) => x.inherited_from) && !explicitGrant(pp, r.recipient)) {
        r.reason_text = `inherited access was turned off but the grant to ${r.recipient} failed — the item is more restricted than intended: ${r.recipient} currently has no access`;
      }
      return r;
    }
    r.permission_id = (res.result && res.result.permission_id) || null;
    const pp = permsOf(post, r.resource);
    if (pp === null) { r.state = 'verify_mismatch'; r.reason_text = 'the item\'s access couldn\'t be re-read to confirm'; return r; }
    if (r.op === 'share') {
      const g = explicitGrant(pp, r.recipient);
      const okRole = g && rank(g.role) >= rank(r.role);
      const okInherit = r.inherit !== false || p.backend === 'onedrive' || !pp.some((x) => x.inherited_from);
      if (okRole && okInherit) r.state = 'applied';
      else { r.state = 'verify_mismatch'; r.reason_text = okRole ? 'inherited access is still present on the item' : 'the grant doesn\'t show up yet'; }
    } else if (r.op === 'unshare') {
      if (!explicitGrant(pp, r.recipient)) r.state = 'applied';
      else { r.state = 'verify_mismatch'; r.reason_text = 'the access still shows up'; }
    } else {
      const owner = ownerOf(post[r.resource]);
      if (owner && owner === lc(r.recipient)) r.state = 'applied';
      else { r.state = 'awaiting_recipient'; r.reason_text = `waiting for ${r.recipient} to accept the transfer in Google Drive`; }
    }
    return r;
  });

  // complete: every row applied or already in effect; none: nothing applied and something
  // unsatisfied; partial: anything else.
  const satisfied = (r) => r.state === 'applied' || r.state === 'skipped_noop';
  const anyApplied = rows.some((r) => r.state === 'applied');
  const run_result = rows.every(satisfied) ? 'complete' : (anyApplied ? 'partial' : 'none');

  let revert_offer = null;
  if (mode === 'all_or_nothing' && rows.some((r) => r.state === 'failed') && anyApplied) {
    revert_offer = rows.filter((r) => r.state === 'applied').map((r) => inverse(r)).filter(Boolean);
  }

  return {
    ok: true,
    run_result,
    rows,
    needs_recheck: rows.some((r) => r.state === 'verify_mismatch'),
    all_or_nothing_declined: aonDeclined,
    revert_offer,
    summary_lines: rows.map(summaryLine),
  };
}

function inverse(r) {
  if (r.op === 'share') {
    return { op: 'unshare', resource: r.resource, resource_label: r.resource_label, recipient: r.recipient, reason: `Undo row ${r.row} after a failure (all-or-nothing)`, source: 'current_state' };
  }
  if (r.op === 'unshare' && r.before !== 'none') {
    return { op: 'share', resource: r.resource, resource_label: r.resource_label, recipient: r.recipient, role: r.before === 'owner' ? 'writer' : r.before, reason: `Undo row ${r.row} after a failure (all-or-nothing)`, source: 'current_state' };
  }
  return null; // ownership transfers are never auto-proposed for revert
}

function summaryLine(r) {
  const what = `#${r.row} ${opWord(r).toLowerCase()} — ${r.resource_label} / ${r.recipient_label}`;
  switch (r.state) {
    case 'applied': return `${what}: done, confirmed on the storage backend.`;
    case 'skipped_noop': return `${what}: skipped — ${r.noop_reason}.`;
    case 'unsupported': return `${what}: not available — ${r.backend_note}.`;
    case 'declined': return `${what}: not applied — you didn't confirm it.`;
    case 'not_attempted': return `${what}: not attempted — an earlier change failed (all-or-nothing).`;
    case 'failed': return `${what}: failed — ${r.reason_text}.`;
    case 'verify_mismatch': return `${what}: not confirmed — ${r.reason_text}. Treated as not applied.`;
    case 'awaiting_recipient': return `${what}: requested — ${r.reason_text}.`;
    default: return `${what}: ${r.state}`;
  }
}

// ---------------------------------------------------------------- record

function record(input) {
  const run = input && input.run;
  const e = [];
  if (!run || typeof run !== 'object') throw new InputError(['run is required']);
  for (const k of ['calling_task', 'purpose', 'confirmer_role', 'backend', 'run_result']) if (!run[k]) e.push(`run.${k} is required`);
  if (!Array.isArray(run.rows)) e.push('run.rows is required (the output rows of `verify`)');
  if (e.length) throw new InputError(e);
  const ts = run.ts || new Date().toISOString();
  const run_id = run.run_id || `${ts.replace(/[-:.TZ]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 8)}`;
  const line = {
    run_id,
    ts,
    calling_task: run.calling_task,
    purpose: run.purpose,
    confirmer_role: run.confirmer_role,
    backend: run.backend,
    table: run.rows.map((r) => ({
      row: r.row, op: r.op, resource: r.resource, recipient: r.recipient, role: r.role,
      inherit: r.inherit, source: r.source, before: r.before, outside_org: r.outside_org, high_impact: r.high_impact,
    })),
    confirmation_text: run.confirmation_text || null,
    per_row_confirmations: run.per_row_confirmations || {},
    results: run.rows.map((r) => ({ row: r.row, state: r.state, permission_id: r.permission_id || null, error: r.error ? (r.error.code || 'ERROR') : null })),
    run_result: run.run_result,
    _v: 1,
  };
  return { ok: true, line: JSON.stringify(line) };
}

// ---------------------------------------------------------------- CLI

function main(argv) {
  const [cmd, ...rest] = argv;
  let inputPath = null;
  let dryRun = false;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--input') inputPath = rest[++i];
    else if (rest[i] === '--dry-run') dryRun = true;
    else return fail([`unknown arg: ${rest[i]}`]);
  }
  const fns = { plan, verify, record };
  if (!fns[cmd]) return fail(['usage: permission-changes.js <plan|verify|record> [--input <file.json>] [--dry-run]']);
  let raw;
  try { raw = require('fs').readFileSync(inputPath || 0, 'utf8'); } catch (err) { return fail([`cannot read input: ${err.message}`]); }
  let input;
  try { input = JSON.parse(raw); } catch (err) { return fail([`input is not valid JSON: ${err.message}`]); }
  try {
    const out = fns[cmd](input);
    process.stdout.write(JSON.stringify(dryRun ? { ok: true, dry_run: true, command: cmd } : out, null, 2) + '\n');
    return 0;
  } catch (err) {
    if (err instanceof InputError) return fail(err.errors);
    throw err;
  }
}

function fail(errors) {
  process.stdout.write(JSON.stringify({ ok: false, errors }, null, 2) + '\n');
  return 2;
}

module.exports = { plan, verify, record, InputError, SOURCES, OPS };

if (require.main === module) process.exitCode = main(process.argv.slice(2));

// AIFS:FILE-END
