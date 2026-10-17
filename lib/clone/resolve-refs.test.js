'use strict';
// Phase U of distribution-channels-test-plan.md. Run: node --test lib/clone/resolve-refs.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { parseLsRemote, highestTag, resolveManifest } = require('./resolve-refs.js');

const LS = (lines) => lines.join('\n');
const CORE = LS([
  'ref: refs/heads/main\tHEAD',
  'aaaaaaa1\tHEAD',
  'aaaaaaa1\trefs/heads/main',
  'ccccccc1\trefs/heads/channel/dev-1',
  'ddddddd1\trefs/heads/feature/x',
  '1111111\trefs/tags/v3.9.1',
  '2222222\trefs/tags/v3.29.2',
  '3333333\trefs/tags/v3.10.0',
  '4444444\trefs/tags/v3.29.2^{}',
  '5555555\trefs/tags/not-a-release',
]);
const NOTAGS = LS(['ref: refs/heads/main\tHEAD', 'eeeeeee1\trefs/heads/main']);
const fx = { 'https://x/core.git': CORE, 'https://x/s3.git': NOTAGS };
const ls = (url) => { if (!(url in fx)) throw new Error('no fixture'); return fx[url]; };

test('U1 tag ordering is numeric: v3.29.2 beats v3.10.0 and v3.9.1 (the old bash bug)', () => {
  assert.equal(highestTag(parseLsRemote(CORE).tags), 'v3.29.2');
});

test('U2 suffix tags rank below the same release and do not break parsing', () => {
  assert.equal(highestTag({ 'v3.32.0-rc1': 'a', 'v3.32.0': 'b', 'v3.31.9': 'c' }), 'v3.32.0');
  assert.equal(highestTag({ 'v3.32.0-rc2': 'a', 'v3.31.0': 'b' }), 'v3.32.0-rc2');
  assert.equal(highestTag({ 'v3.32.0-rc2': 'a', 'v3.32.0-rc10': 'b' }), 'v3.32.0-rc10');
});

test('U3 annotated tags resolve to the peeled commit', () => {
  assert.equal(parseLsRemote(CORE).tags['v3.29.2'], '4444444');
});

test('U4 channel branch present -> channel head', () => {
  const r = resolveManifest({ mode: 'infra', channel: 'dev-1', repos: [{ name: 'core', git_url: 'https://x/core.git' }] }, ls);
  assert.deepEqual([r.repos[0].ref_type, r.repos[0].ref, r.repos[0].commit], ['channel', 'channel/dev-1', 'ccccccc1']);
});

test('U5 channel branch absent -> falls back to the highest tag (infra)', () => {
  const r = resolveManifest({ mode: 'infra', channel: 'dev-2', repos: [{ name: 'core', git_url: 'https://x/core.git' }] }, ls);
  assert.deepEqual([r.repos[0].ref_type, r.repos[0].ref], ['tag', 'v3.29.2']);
});

test('U6 no channel set -> highest tag (production behaviour)', () => {
  const r = resolveManifest({ mode: 'infra', repos: [{ name: 'core', git_url: 'https://x/core.git' }] }, ls);
  assert.equal(r.channel, null);
  assert.equal(r.repos[0].ref, 'v3.29.2');
});

test('U7 zero tags -> default-branch head (infra), want_version carried for the phantom check', () => {
  const r = resolveManifest({ mode: 'infra', repos: [{ name: 's3', git_url: 'https://x/s3.git', version: '1.0.0' }] }, ls);
  assert.deepEqual([r.repos[0].ref_type, r.repos[0].ref, r.repos[0].want_version], ['branch_head', 'main', '1.0.0']);
});

test('U8 collections mode without version: channel when present, else default-branch head', () => {
  const a = resolveManifest({ mode: 'collections', channel: 'dev-1', repos: [{ name: 'core', git_url: 'https://x/core.git' }] }, ls);
  assert.equal(a.repos[0].ref_type, 'channel');
  const b = resolveManifest({ mode: 'collections', repos: [{ name: 'core', git_url: 'https://x/core.git' }] }, ls);
  assert.deepEqual([b.repos[0].ref_type, b.repos[0].ref], ['branch_head', 'main']);
});

test('U8b collections mode with version: tag v<version>, not default-branch head (bug 20260926-8d20ea22-133903-0ddf)', () => {
  const r = resolveManifest({ mode: 'collections', repos: [{ name: 'core', git_url: 'https://x/core.git', version: '3.10.0' }] }, ls);
  assert.deepEqual([r.repos[0].ref_type, r.repos[0].ref, r.repos[0].commit, r.repos[0].want_version], ['tag', 'v3.10.0', '3333333', '3.10.0']);
  // not the highest tag either: the manifest version wins
  const a = resolveManifest({ mode: 'collections', repos: [{ name: 'core', git_url: 'https://x/core.git', version: '3.29.2' }] }, ls);
  assert.deepEqual([a.repos[0].ref, a.repos[0].commit], ['v3.29.2', '4444444']);
  // a leading "v" in the manifest version is tolerated
  const v = resolveManifest({ mode: 'collections', repos: [{ name: 'core', git_url: 'https://x/core.git', version: 'v3.9.1' }] }, ls);
  assert.equal(v.repos[0].ref, 'v3.9.1');
});

test('U8c collections mode with version but no such tag -> loud per-repo error, no HEAD fallback', () => {
  const r = resolveManifest({ mode: 'collections', repos: [{ name: 'core', git_url: 'https://x/core.git', version: '9.9.9' }] }, ls);
  assert.equal(r.repos.length, 0);
  assert.equal(r.errors.length, 1);
  assert.match(r.errors[0].error, /v9\.9\.9 not found.*tagnofallback/);
});

test('U8e collections mode with version on a zero-tag repo -> default-branch head + want_version (driver phantom check)', () => {
  const r = resolveManifest({ mode: 'collections', repos: [{ name: 's3', git_url: 'https://x/s3.git', version: '1.0.0' }] }, ls);
  assert.deepEqual([r.repos[0].ref_type, r.repos[0].ref, r.repos[0].want_version], ['branch_head', 'main', '1.0.0']);
});

test('U8d collections mode with version on a channel org: channel branch still wins, tag when the branch is absent', () => {
  const a = resolveManifest({ mode: 'collections', channel: 'dev-1', repos: [{ name: 'core', git_url: 'https://x/core.git', version: '3.10.0' }] }, ls);
  assert.deepEqual([a.repos[0].ref_type, a.repos[0].ref], ['channel', 'channel/dev-1']);
  const b = resolveManifest({ mode: 'collections', channel: 'dev-2', repos: [{ name: 'core', git_url: 'https://x/core.git', version: '3.10.0' }] }, ls);
  assert.deepEqual([b.repos[0].ref_type, b.repos[0].ref], ['tag', 'v3.10.0']);
});

test('U9 invalid channel names are rejected', () => {
  for (const bad of ['Dev-1', 'dev 1', 'channel/dev-1', '-dev', 'x'.repeat(41), 'dev_1']) {
    assert.throws(() => resolveManifest({ mode: 'infra', channel: bad, repos: [] }, ls), /invalid channel name/);
  }
});

test('U10 per-repo failures are reported, other repos still resolve', () => {
  const r = resolveManifest({ mode: 'infra', repos: [{ name: 'core', git_url: 'https://x/core.git' }, { name: 'gone', git_url: 'https://x/gone.git' }, { name: 'nourl' }] }, ls);
  assert.equal(r.repos.length, 1);
  assert.equal(r.errors.length, 2);
});

test('U11 CLI: output schema, exit 2 on a bad channel, fixture mode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-'));
  const fxp = path.join(dir, 'fx.json'); fs.writeFileSync(fxp, JSON.stringify(fx));
  const good = path.join(dir, 'm.json'); fs.writeFileSync(good, JSON.stringify({ mode: 'infra', channel: 'dev-1', repos: [{ name: 'core', git_url: 'https://x/core.git' }] }));
  const out = spawnSync(process.execPath, [path.join(__dirname, 'resolve-refs.js'), good, '--ls-remote-fixture', fxp], { encoding: 'utf8' });
  assert.equal(out.status, 0);
  const j = JSON.parse(out.stdout);
  assert.deepEqual(Object.keys(j).sort(), ['channel', 'errors', 'mode', 'ok', 'repos']);
  const bad = path.join(dir, 'b.json'); fs.writeFileSync(bad, JSON.stringify({ mode: 'infra', channel: 'Bad Name', repos: [] }));
  assert.equal(spawnSync(process.execPath, [path.join(__dirname, 'resolve-refs.js'), bad, '--ls-remote-fixture', fxp]).status, 2);
  const src = fs.readFileSync(path.join(__dirname, 'resolve-refs.js'), 'utf8');
  assert.equal(src.includes('\r'), false);
  assert.match(src.trimEnd(), /\/\/ AIFS:FILE-END$/);
});

// AIFS:FILE-END
