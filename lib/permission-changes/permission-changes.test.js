'use strict';
// Phase U of retire-permission-helper-test-plan.md. Run: node --test lib/permission-changes/
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { plan, verify, record, InputError } = require('./permission-changes.js');

const GROUP = 'all@example.org';
const ORG_GD = { backend: 'gdrive', all_members_group: GROUP, member_identities: ['owner@example.org', 'pat@example.org', 'sam@example.org'] };
const ORG_OD = { backend: 'onedrive', all_members_group: GROUP, member_identities: ['pat@example.org', 'pat.upn@tenant.onmicrosoft.com'] };

const perm = (subject, role, inherited_from = null) => ({ subject, role, permission_id: `p-${subject}-${role}`, inherited_from });
const base = (changes, current, org = ORG_GD, extra = {}) => ({
  calling_task: 'test-task', purpose: 'Test purpose', confirmer: 'owner', changes, current, org, ...extra,
});
const share = (o = {}) => ({ op: 'share', resource: 'id:F1', recipient: 'pat@example.org', role: 'reader', reason: 'asked', source: 'member_request', ...o });

// ---- plan

test('U1 share: recipient already has same or higher role directly -> skipped', () => {
  const out = plan(base([share({ role: 'reader' })], { 'id:F1': { permissions: [perm('pat@example.org', 'writer')] } }));
  assert.equal(out.rows[0].state, 'skipped_noop');
  assert.equal(out.rows[0].noop_reason, 'already has writer');
  assert.equal(out.nothing_to_change, true);
});

test('U2 share: role held via all-members group -> skipped (group target and member target)', () => {
  const cur = { '/shared/x/': { permissions: [perm(GROUP, 'writer', '/shared/')] } };
  const g = plan(base([share({ resource: '/shared/x/', recipient: GROUP, role: 'writer', source: 'collaborative_acls' })], cur));
  assert.equal(g.rows[0].state, 'skipped_noop');
  assert.match(g.rows[0].noop_reason, /inherited from \/shared\//);
  const m = plan(base([share({ resource: '/shared/x/', role: 'reader' })], cur));
  assert.equal(m.rows[0].state, 'skipped_noop');
  assert.match(m.rows[0].noop_reason, /via all@example.org/);
});

test('U3 share: lower role -> proposed with before/after', () => {
  const out = plan(base([share({ role: 'writer' })], { 'id:F1': { permissions: [perm('pat@example.org', 'reader')] } }));
  const r = out.rows[0];
  assert.equal(r.state, 'proposed');
  assert.equal(r.before, 'reader');
  assert.equal(r.after, 'writer');
  assert.equal(r.high_impact, false);
  assert.deepEqual(out.standard_rows, [1]);
  assert.match(out.table_markdown, /\| 1 \| Share \|/);
  assert.match(out.confirmation_prompt, /Reply \*\*confirm\*\*/);
});

test('U4 unshare with explicit grant -> proposed, high impact', () => {
  const out = plan(base([{ op: 'unshare', resource: 'id:F1', recipient: 'pat@example.org', reason: 'asked', source: 'member_request' }],
    { 'id:F1': { permissions: [perm('pat@example.org', 'writer')] } }));
  assert.equal(out.rows[0].state, 'proposed');
  assert.equal(out.rows[0].high_impact, true);
  assert.deepEqual(out.high_impact_rows, [1]);
  assert.match(out.table_markdown, /Needs individual confirmation/);
});

test('U5 unshare where access is inherited only -> skipped with explanation', () => {
  const out = plan(base([{ op: 'unshare', resource: 'id:F1', recipient: 'pat@example.org', reason: 'asked', source: 'member_request' }],
    { 'id:F1': { permissions: [perm('pat@example.org', 'reader', '/parent/')] } }));
  assert.equal(out.rows[0].state, 'skipped_noop');
  assert.equal(out.rows[0].noop_reason, "access is inherited from /parent/ and can't be removed here");
});

test('U6 recipient outside the org is flagged, not blocked', () => {
  const out = plan(base([share({ recipient: 'friend@other.com' })], { 'id:F1': { permissions: [] } }));
  assert.equal(out.rows[0].outside_org, true);
  assert.equal(out.rows[0].state, 'proposed');
  assert.match(out.table_markdown, /outside your org/);
  assert.match(out.consequence_lines[0], /outside your org/);
});

test('U7 recipient matched by sharing_identity (onedrive UPN) is not outside-org', () => {
  const out = plan(base([share({ recipient: 'Pat.UPN@tenant.onmicrosoft.com' })], { 'id:F1': { permissions: [] } }, ORG_OD));
  assert.equal(out.rows[0].outside_org, false);
});

test('U8 inherit:false on gdrive is high impact', () => {
  const out = plan(base([share({ inherit: false })], { 'id:F1': { permissions: [perm(GROUP, 'reader', '/shared/')] } }));
  assert.equal(out.rows[0].high_impact, true);
  assert.match(out.rows[0].backend_note, /organizer/);
  assert.match(out.consequence_lines[0], /lose access/);
});

test('U9 inherit:false on onedrive is additive with a note', () => {
  const out = plan(base([share({ inherit: false })], { 'id:F1': { permissions: [] } }, ORG_OD));
  assert.equal(out.rows[0].high_impact, false);
  assert.match(out.rows[0].backend_note, /additive; parent access unchanged/);
});

test('U10 transfer on onedrive or Shared Drive is unsupported and not offered', () => {
  const t = { op: 'transfer_ownership', resource: 'id:F1', recipient: 'pat@example.org', reason: 'asked', source: 'member_request' };
  const od = plan(base([t], { 'id:F1': { permissions: [] } }, ORG_OD));
  assert.equal(od.rows[0].state, 'unsupported');
  const sd = plan(base([t], { 'id:F1': { permissions: [], location: 'shared_drive' } }));
  assert.equal(sd.rows[0].state, 'unsupported');
  assert.deepEqual(sd.high_impact_rows, []);
  const md = plan(base([t], { 'id:F1': { permissions: [perm('owner@example.org', 'owner')], location: 'my_drive' } }));
  assert.equal(md.rows[0].state, 'proposed');
  assert.equal(md.rows[0].before, 'owner: owner@example.org');
});

test('U11 every row a no-op -> nothing to change', () => {
  const out = plan(base([share()], { 'id:F1': { permissions: [perm('pat@example.org', 'reader')] } }));
  assert.equal(out.nothing_to_change, true);
  assert.equal(out.confirmation_prompt, null);
  assert.match(out.table_markdown, /Nothing to change/);
});

test('U12 invalid inputs are rejected with no partial output', () => {
  const cur = { 'id:F1': { permissions: [] } };
  for (const bad of [share({ source: undefined }), share({ role: 'owner' }), share({ resource: 'id:F1/doc.md' }), share({ recipient: 'nobody' }), share({ reason: '' }), share({ reason: 42 })]) {
    assert.throws(() => plan(base([bad], cur)), InputError);
  }
  assert.throws(() => plan(base([share()], {})), /current state missing/);
  assert.throws(() => plan(base([share()], cur, ORG_GD, { confirmer: 'agent' })), InputError);
});

test('U15 reason defaults to the run purpose; collection_admin confirmer accepted', () => {
  const c = share(); delete c.reason;
  const out = plan(base([c], { 'id:F1': { permissions: [] } }, ORG_GD, { confirmer: 'collection_admin' }));
  assert.equal(out.rows[0].reason, 'Test purpose');
  assert.equal(out.confirmer, 'collection_admin');
});

test('U13 a source describing read content cannot be expressed', () => {
  for (const s of ['document', 'read_content', 'tool_output', 'message']) {
    assert.throws(() => plan(base([share({ source: s })], { 'id:F1': { permissions: [] } })), /content the agent read/);
  }
});

// ---- verify

const plannedShare = () => plan(base([share({ role: 'writer' })], { 'id:F1': { permissions: [] } }));
const all = { standard: 'all' };

test('V1 applied when the grant shows up', () => {
  const out = verify({ plan: plannedShare(), confirmation: all, apply_results: { 1: { ok: true, result: { shared: true, permission_id: 'X' } } },
    post: { 'id:F1': { permissions: [perm('pat@example.org', 'writer')] } } });
  assert.equal(out.rows[0].state, 'applied');
  assert.equal(out.rows[0].permission_id, 'X');
  assert.equal(out.run_result, 'complete');
});

test('V2 verify_mismatch when the grant does not show up', () => {
  const out = verify({ plan: plannedShare(), confirmation: all, apply_results: { 1: { ok: true, result: { shared: true } } }, post: { 'id:F1': { permissions: [] } } });
  assert.equal(out.rows[0].state, 'verify_mismatch');
  assert.equal(out.needs_recheck, true);
  assert.equal(out.run_result, 'none');
});

test('V3 failed with plain-words reason', () => {
  const out = verify({ plan: plannedShare(), confirmation: all, apply_results: { 1: { ok: false, error: { code: 'INVALID_RECIPIENT', message: 'x' } } }, post: { 'id:F1': { permissions: [] } } });
  assert.equal(out.rows[0].state, 'failed');
  assert.match(out.rows[0].reason_text, /isn't a valid account/);
});

test('V4 inherit:false half-state reported as more restricted than intended', () => {
  const p = plan(base([share({ inherit: false })], { 'id:F1': { permissions: [perm(GROUP, 'reader', '/shared/')] } }));
  const out = verify({ plan: p, confirmation: { standard: 'none', high_impact_confirmed: [1] },
    apply_results: { 1: { ok: false, error: { code: 'RATE_LIMITED' } } }, post: { 'id:F1': { permissions: [] } } });
  assert.equal(out.rows[0].state, 'failed');
  assert.match(out.rows[0].reason_text, /more restricted than intended/);
  const denied = verify({ plan: p, confirmation: { standard: 'none', high_impact_confirmed: [1] },
    apply_results: { 1: { ok: false, error: { code: 'ACCESS_DENIED' } } }, post: { 'id:F1': { permissions: [perm(GROUP, 'reader', '/shared/')] } } });
  assert.match(denied.rows[0].reason_text, /organizer/);
});

test('V5 transfer: owner unchanged -> awaiting_recipient; changed -> applied', () => {
  const t = { op: 'transfer_ownership', resource: 'id:F1', recipient: 'pat@example.org', reason: 'asked', source: 'member_request' };
  const p = plan(base([t], { 'id:F1': { permissions: [perm('owner@example.org', 'owner')], location: 'my_drive' } }));
  const c = { standard: 'none', high_impact_confirmed: [1] };
  const ok = { 1: { ok: true, result: { transferred: true } } };
  const waiting = verify({ plan: p, confirmation: c, apply_results: ok, post: { 'id:F1': { permissions: [perm('owner@example.org', 'owner')] } } });
  assert.equal(waiting.rows[0].state, 'awaiting_recipient');
  const done = verify({ plan: p, confirmation: c, apply_results: ok, post: { 'id:F1': { owner: 'pat@example.org', permissions: [] } } });
  assert.equal(done.rows[0].state, 'applied');
});

test('V6 all_or_nothing: stop at failure, later rows not attempted, revert offered (never applied)', () => {
  const changes = [share({ resource: 'id:A' }), share({ resource: 'id:B' }), share({ resource: 'id:C' })];
  const empty = { permissions: [] };
  const p = plan(base(changes, { 'id:A': empty, 'id:B': empty, 'id:C': empty }, ORG_GD, { mode: 'all_or_nothing', confirmer: 'admin' }));
  const out = verify({ plan: p, confirmation: all,
    apply_results: { 1: { ok: true, result: { shared: true } }, 2: { ok: false, error: { code: 'ACCESS_DENIED' } } },
    post: { 'id:A': { permissions: [perm('pat@example.org', 'reader')] }, 'id:B': empty, 'id:C': empty } });
  assert.deepEqual(out.rows.map((r) => r.state), ['applied', 'failed', 'not_attempted']);
  assert.equal(out.run_result, 'partial');
  assert.equal(out.revert_offer.length, 1);
  assert.equal(out.revert_offer[0].op, 'unshare');
  assert.equal(out.revert_offer[0].source, 'current_state');
});

test('V7 run_result and confirmation handling', () => {
  const changes = [share({ resource: 'id:A' }), share({ resource: 'id:B' })];
  const empty = { permissions: [] };
  const p = plan(base(changes, { 'id:A': empty, 'id:B': empty }));
  const posted = { 'id:A': { permissions: [perm('pat@example.org', 'reader')] }, 'id:B': empty };
  const skip2 = verify({ plan: p, confirmation: { standard: 'all', declined_rows: [2] }, apply_results: { 1: { ok: true, result: {} } }, post: posted });
  assert.deepEqual(skip2.rows.map((r) => r.state), ['applied', 'declined']);
  assert.equal(skip2.run_result, 'partial');
  const cancelled = verify({ plan: p, confirmation: { standard: 'none' }, apply_results: {}, post: {} });
  assert.deepEqual(cancelled.rows.map((r) => r.state), ['declined', 'declined']);
  assert.equal(cancelled.run_result, 'none');
  // high-impact rows are declined unless individually confirmed, even when the table was confirmed
  const u = plan(base([{ op: 'unshare', resource: 'id:A', recipient: 'pat@example.org', reason: 'r', source: 'current_state' }],
    { 'id:A': { permissions: [perm('pat@example.org', 'reader')] } }));
  const notIndividually = verify({ plan: u, confirmation: { standard: 'all' }, apply_results: { 1: { ok: true, result: {} } }, post: { 'id:A': empty } });
  assert.equal(notIndividually.rows[0].state, 'declined');
});

test('V9 all_or_nothing: declining any row declines the whole set, even if others were confirmed', () => {
  const un = (res) => ({ op: 'unshare', resource: res, recipient: 'pat@example.org', reason: 'r', source: 'current_state' });
  const held = { permissions: [perm('pat@example.org', 'writer')] };
  const p = plan(base([un('id:A'), un('id:B')], { 'id:A': held, 'id:B': held }, ORG_GD, { mode: 'all_or_nothing', confirmer: 'admin' }));
  const out = verify({ plan: p, confirmation: { standard: 'none', high_impact_confirmed: [1] }, apply_results: {}, post: {} });
  assert.deepEqual(out.rows.map((r) => r.state), ['declined', 'declined']);
  assert.equal(out.all_or_nothing_declined, true);
  assert.equal(out.run_result, 'none');
  const indep = plan(base([un('id:A'), un('id:B')], { 'id:A': held, 'id:B': held }));
  const out2 = verify({ plan: indep, confirmation: { standard: 'none', high_impact_confirmed: [1] }, apply_results: { 1: { ok: true, result: {} } }, post: { 'id:A': { permissions: [] }, 'id:B': held } });
  assert.deepEqual(out2.rows.map((r) => r.state), ['applied', 'declined']);
});

// ---- record

// getpermsinheritedmask (3.32.0 live test): from gdrive adapter 2.11.2 a principal with BOTH an
// inherited and a direct grant on the same item is reported as two entries. The procedure must
// verify the direct grant and be able to plan its removal.
test('V10 direct grant layered on inherited access: verify applied; unshare plannable', () => {
  const cur = { '/shared/x/': { permissions: [perm(GROUP, 'reader', '/shared/')] } };
  const p = plan(base([share({ resource: '/shared/x/', recipient: GROUP, role: 'writer', source: 'collaborative_acls' })], cur, ORG_GD, { confirmer: 'admin' }));
  assert.equal(p.rows[0].state, 'proposed');
  const post = { '/shared/x/': { permissions: [perm(GROUP, 'reader', '/shared/'), perm(GROUP, 'writer')] } };
  const out = verify({ plan: p, confirmation: { standard: 'all' }, apply_results: { 1: { ok: true, result: { shared: true } } }, post });
  assert.equal(out.rows[0].state, 'applied');
  const un = plan(base([{ op: 'unshare', resource: '/shared/x/', recipient: GROUP, reason: 'asked', source: 'member_request' }], post, ORG_GD, { confirmer: 'admin' }));
  assert.equal(un.rows[0].state, 'proposed');
  const after = { '/shared/x/': { permissions: [perm(GROUP, 'reader', '/shared/')] } };
  const done = verify({ plan: un, confirmation: { standard: 'none', high_impact_confirmed: [1] }, apply_results: { 1: { ok: true, result: { unshared: true } } }, post: after });
  assert.equal(done.rows[0].state, 'applied');
});

test('V8 record line matches schema', () => {
  const p = plannedShare();
  const v = verify({ plan: p, confirmation: all, apply_results: { 1: { ok: true, result: { permission_id: 'X' } } }, post: { 'id:F1': { permissions: [perm('pat@example.org', 'writer')] } } });
  const { line } = record({ run: { calling_task: 'test-task', purpose: 'Test purpose', confirmer_role: 'owner', backend: 'gdrive', rows: v.rows, run_result: v.run_result, confirmation_text: 'confirm', ts: '2026-10-01T12:00:00.000Z', run_id: 'r1' } });
  assert.equal(line.includes('\n'), false);
  const o = JSON.parse(line);
  assert.equal(o._v, 1);
  assert.equal(o.run_id, 'r1');
  assert.equal(o.confirmation_text, 'confirm');
  assert.deepEqual(o.results, [{ row: 1, state: 'applied', permission_id: 'X', error: null }]);
  assert.equal(o.table[0].source, 'member_request');
  assert.throws(() => record({ run: { rows: [] } }), InputError);
});

// ---- 4.0.1 (findings 63, 65, 72, 75)

test('U16 drive-qualified id anchor is accepted as a resource (OneDrive cross-drive)', () => {
  const out = plan(base([share({ resource: 'id:b!drive123:ITEM9' })], { 'id:b!drive123:ITEM9': { permissions: [] } }, ORG_OD));
  assert.equal(out.rows[0].state, 'proposed');
  assert.throws(() => plan(base([share({ resource: 'id:b!drive123:ITEM9/api' })], { 'id:b!drive123:ITEM9/api': { permissions: [] } }, ORG_OD)), /composite/);
});

test('U17 task_spec reader row where the group already holds writer -> skipped with a visible excess note', () => {
  const cur = { '/projects': { permissions: [perm(GROUP, 'writer', '/')] } };
  const out = plan(base([share({ resource: '/projects', recipient: GROUP, role: 'reader', source: 'task_spec' })], cur, ORG_OD, { confirmer: 'admin' }));
  assert.equal(out.rows[0].state, 'skipped_noop');
  assert.equal(out.rows[0].excess_access, true);
  assert.match(out.rows[0].noop_reason, /^already has writer .*more than this needs \(reader\)$/);
  assert.match(out.table_markdown, /Not changing[\s\S]*more than this needs/);
  // same role held -> plain no-op, no note; member_request rows never get the note
  const same = plan(base([share({ resource: '/projects', recipient: GROUP, role: 'writer', source: 'task_spec' })], cur, ORG_OD));
  assert.equal(same.rows[0].excess_access, false);
  const req = plan(base([share({ role: 'reader' })], { 'id:F1': { permissions: [perm('pat@example.org', 'writer')] } }));
  assert.equal(req.rows[0].excess_access, false);
});

test('U18 onedrive outside-org share carries the tenant sharing note', () => {
  const out = plan(base([share({ recipient: 'friend@gmail.com' })], { 'id:F1': { permissions: [] } }, ORG_OD));
  assert.equal(out.rows[0].outside_org, true);
  assert.match(out.rows[0].backend_note, /tenant's sharing settings/);
  const gd = plan(base([share({ recipient: 'friend@gmail.com' })], { 'id:F1': { permissions: [] } }));
  assert.equal(gd.rows[0].backend_note, null);
});

test('V11 external-share policy refusal and onedrive non-tenant INVALID_SUBJECT get distinct plain wording', () => {
  const p = plan(base([share({ recipient: 'friend@gmail.com' })], { 'id:F1': { permissions: [] } }, ORG_OD));
  const pol = verify({ plan: p, confirmation: all, apply_results: { 1: { ok: false, error: { code: 'EXTERNAL_SHARE_BLOCKED', message: "Your organization's sharing settings don't allow sharing with people outside the organization", reason: 'External sharing is disabled for this site' } } }, post: { 'id:F1': { permissions: [] } } });
  assert.equal(pol.rows[0].state, 'failed');
  assert.match(pol.rows[0].reason_text, /Microsoft 365 sharing settings don't allow sharing with people outside the org \(the backend said: External sharing is disabled/);
  const inv = verify({ plan: p, confirmation: all, apply_results: { 1: { ok: false, error: { code: 'INVALID_SUBJECT', message: 'x' } } }, post: { 'id:F1': { permissions: [] } } });
  assert.match(inv.rows[0].reason_text, /isn't a valid account or group in your Microsoft 365 tenant — they must be added to the tenant first \(a guest account counts\)/);
  const gp = plan(base([share({ recipient: 'friend@gmail.com' })], { 'id:F1': { permissions: [] } }));
  const gpol = verify({ plan: gp, confirmation: all, apply_results: { 1: { ok: false, error: { code: 'POLICY_DENIED', message: 'Sharing outside of your domain is not allowed by your administrator' } } }, post: { 'id:F1': { permissions: [] } } });
  assert.equal(gpol.rows[0].reason_text, "your Google Workspace sharing settings don't allow sharing with people outside the org (the backend said: Sharing outside of your domain is not allowed by your administrator)");
});

test('V12 generic backend refusal is worded as likely, not as fact (finding 84)', () => {
  const p = plan(base([share({ recipient: 'friend@gmail.com' })], { 'id:F1': { permissions: [] } }, ORG_OD));
  const canned = "Your organization's sharing settings don't allow sharing with people outside the organization";
  // Graph's generic 400 sharingFailed: the adapter infers EXTERNAL_SHARE_BLOCKED, Graph's text names no policy.
  const gen = verify({ plan: p, confirmation: all, apply_results: { 1: { ok: false, error: { code: 'EXTERNAL_SHARE_BLOCKED', message: canned, reason: 'There was a problem sharing, please try again later.', graph_status: 400, graph_code: 'sharingFailed' } } }, post: { 'id:F1': { permissions: [] } } });
  assert.equal(gen.rows[0].state, 'failed');
  assert.equal(gen.rows[0].reason_text, "Microsoft refused to share outside the org — usually the tenant's external-sharing setting (SharePoint admin center → Policies → Sharing) (the backend said: sharingFailed: There was a problem sharing, please try again later.)");
  assert.doesNotMatch(gen.rows[0].reason_text, /settings don't allow/);
  // No Graph text at all: the adapter's canned message is never treated as the backend's own words.
  const none = verify({ plan: p, confirmation: all, apply_results: { 1: { ok: false, error: { code: 'EXTERNAL_SHARE_BLOCKED', message: canned, reason: null, graph_status: 400, graph_code: null } } }, post: { 'id:F1': { permissions: [] } } });
  assert.equal(none.rows[0].reason_text, "Microsoft refused to share outside the org — usually the tenant's external-sharing setting (SharePoint admin center → Policies → Sharing)");
  // A policy-specific Graph reason keeps the direct wording.
  const spec = verify({ plan: p, confirmation: all, apply_results: { 1: { ok: false, error: { code: 'EXTERNAL_SHARE_BLOCKED', message: canned, reason: 'External sharing is disabled for this site', graph_status: 403, graph_code: 'notAllowed' } } }, post: { 'id:F1': { permissions: [] } } });
  assert.match(spec.rows[0].reason_text, /^your Microsoft 365 sharing settings don't allow sharing with people outside the org \(the backend said: External sharing is disabled for this site\)$/);
  // gdrive with no text.
  const gp = plan(base([share({ recipient: 'friend@gmail.com' })], { 'id:F1': { permissions: [] } }));
  const gnone = verify({ plan: gp, confirmation: all, apply_results: { 1: { ok: false, error: { code: 'POLICY_DENIED', message: '' } } }, post: { 'id:F1': { permissions: [] } } });
  assert.equal(gnone.rows[0].reason_text, "Google refused to share outside the org — usually the domain's external-sharing setting (Google Admin → Drive sharing)");
});

// ---- CLI / hygiene

test('U14 CLI: exit 2 on bad input, --dry-run, sentinel, LF', () => {
  const script = path.join(__dirname, 'permission-changes.js');
  const bad = spawnSync(process.execPath, [script, 'plan'], { input: '{"changes":[]}' });
  assert.equal(bad.status, 2);
  assert.equal(JSON.parse(bad.stdout).ok, false);
  // --dry-run still validates (exit 2 on bad input) but emits no result payload on success
  const validRun = JSON.stringify({ run: { calling_task: 't', purpose: 'p', confirmer_role: 'owner', backend: 'gdrive', rows: [], run_result: 'complete' } });
  const dry = spawnSync(process.execPath, [script, 'record', '--dry-run'], { input: validRun });
  assert.equal(dry.status, 0);
  assert.deepEqual(JSON.parse(dry.stdout), { ok: true, dry_run: true, command: 'record' });
  const dryBad = spawnSync(process.execPath, [script, 'record', '--dry-run'], { input: '{}' });
  assert.equal(dryBad.status, 2);
  const usage = spawnSync(process.execPath, [script, 'nope'], { input: '{}' });
  assert.equal(usage.status, 2);
  const src = require('node:fs').readFileSync(script, 'utf8');
  assert.equal(src.includes('\r'), false);
  assert.match(src.trimEnd(), /\/\/ AIFS:FILE-END$/);
});

// AIFS:FILE-END
