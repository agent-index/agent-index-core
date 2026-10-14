#!/usr/bin/env node
/*
 * resolve-refs.js -- the ONE place that decides which git ref of each repo an install clones
 * (agent-index-core lib/clone; Level 3). Both clone-repos drivers (.sh / .ps1) call this and then
 * only execute the decision, so the two platforms can never disagree about "the highest tag" again
 * (the bash driver used to sort on the first dot-field only and pick v3.9.1 over v3.29.2).
 *
 * Distribution channels (core 3.32.0): when the manifest names a `channel`, any repo that has a
 * branch `channel/<channel>` is taken from that branch head; every other repo falls back to the
 * normal rule (infra: highest v* release tag; collections: default-branch head).
 *
 * Usage:
 *   node resolve-refs.js <clone-manifest.json> [--ls-remote-fixture <file.json>]
 *   (the fixture maps git_url -> raw `git ls-remote --symref` output; for tests only)
 * Output (stdout JSON): { ok, channel, mode, repos: [ {name, git_url, mode, ref_type, ref, commit, want_version} ], errors }
 *   ref_type: "channel" | "tag" | "branch_head"
 * Exit: 0 = resolved (per-repo errors are listed in `errors`, repos with errors are omitted);
 *       2 = invalid manifest / channel name / usage.
 */
'use strict';
const fs = require('fs');
const { execFileSync } = require('child_process');

const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;

// ---- parsing ---------------------------------------------------------------------------------

/** Parse `git ls-remote --symref <url>` output into {defaultBranch, heads:{name:sha}, tags:{name:sha}}. */
function parseLsRemote(text) {
  const out = { defaultBranch: null, heads: {}, tags: {} };
  const peeled = {};
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    let m = line.match(/^ref:\s+refs\/heads\/(\S+)\s+HEAD$/);
    if (m) { out.defaultBranch = m[1]; continue; }
    m = line.match(/^([0-9a-f]{7,64})\s+refs\/heads\/(.+)$/);
    if (m) { out.heads[m[2]] = m[1]; continue; }
    m = line.match(/^([0-9a-f]{7,64})\s+refs\/tags\/(.+?)(\^\{\})?$/);
    if (m) { if (m[3]) peeled[m[2]] = m[1]; else if (!(m[2] in out.tags)) out.tags[m[2]] = m[1]; continue; }
  }
  for (const [t, sha] of Object.entries(peeled)) out.tags[t] = sha; // annotated tags -> commit sha
  if (!out.defaultBranch) out.defaultBranch = out.heads.main ? 'main' : (out.heads.master ? 'master' : null);
  return out;
}

/** Parse a release tag "vX.Y.Z[-pre]" into a comparable record, or null if it isn't one. */
function parseTag(tag) {
  const m = /^v(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?$/.exec(tag);
  if (!m) return null;
  return { tag, nums: m[1].split('.').map(Number), pre: m[2] || null };
}

/** Numeric semver-style comparison; a pre-release ranks below the same release (v1.2.0-rc1 < v1.2.0). */
function compareTags(a, b) {
  const n = Math.max(a.nums.length, b.nums.length);
  for (let i = 0; i < n; i++) {
    const x = a.nums[i] || 0, y = b.nums[i] || 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  if (a.pre === b.pre) return 0;
  if (a.pre === null) return 1;
  if (b.pre === null) return -1;
  // compare pre-release identifiers piecewise, numerically where both are numeric (rc2 < rc10)
  const pa = a.pre.split(/[.-]/), pb = b.pre.split(/[.-]/);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i], y = pb[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const xm = /^(\D*)(\d*)$/.exec(x), ym = /^(\D*)(\d*)$/.exec(y);
    if (xm && ym && xm[1] === ym[1] && xm[2] !== '' && ym[2] !== '') {
      const xn = Number(xm[2]), yn = Number(ym[2]);
      if (xn !== yn) return xn < yn ? -1 : 1;
      continue;
    }
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0;
}

function highestTag(tags) {
  const parsed = Object.keys(tags).map(parseTag).filter(Boolean);
  if (!parsed.length) return null;
  parsed.sort(compareTags);
  return parsed[parsed.length - 1].tag;
}

// ---- resolution ------------------------------------------------------------------------------

/** Decide the ref for one repo. Pure: `ls` is the parsed ls-remote result. */
function resolveRepo(repo, mode, channel, ls) {
  const base = { name: repo.name, git_url: repo.git_url, mode, want_version: repo.version || null };
  if (channel) {
    const br = `channel/${channel}`;
    if (ls.heads[br]) return { ...base, ref_type: 'channel', ref: br, commit: ls.heads[br] };
  }
  if (mode === 'infra') {
    const tag = highestTag(ls.tags);
    if (tag) return { ...base, ref_type: 'tag', ref: tag, commit: ls.tags[tag] };
  }
  if (!ls.defaultBranch) return { ...base, error: 'remote has no default branch and no usable tag/channel ref' };
  return { ...base, ref_type: 'branch_head', ref: ls.defaultBranch, commit: ls.heads[ls.defaultBranch] || null };
}

function resolveManifest(manifest, lsRemote) {
  const errors = [];
  const mode = manifest.mode;
  if (mode !== 'infra' && mode !== 'collections') throw new Error(`mode must be infra|collections (got: ${mode})`);
  const channel = manifest.channel == null || manifest.channel === '' ? null : String(manifest.channel);
  if (channel !== null && !CHANNEL_RE.test(channel)) {
    throw new Error(`invalid channel name "${channel}" — use lowercase letters, digits and hyphens (max 40), e.g. dev-1`);
  }
  if (!Array.isArray(manifest.repos)) throw new Error('repos must be an array');
  const repos = [];
  for (const r of manifest.repos) {
    if (!r || !r.name || !r.git_url) { errors.push({ name: r && r.name, error: 'manifest entry missing name/git_url' }); continue; }
    let ls;
    try { ls = parseLsRemote(lsRemote(r.git_url)); } catch (e) { errors.push({ name: r.name, error: `git ls-remote failed: ${e.message}` }); continue; }
    const res = resolveRepo(r, mode, channel, ls);
    if (res.error) errors.push({ name: r.name, error: res.error }); else repos.push(res);
  }
  return { ok: true, channel, mode, repos, errors };
}

// ---- CLI ---------------------------------------------------------------------------------------

function main(argv) {
  const [manifestPath, ...rest] = argv;
  let fixture = null;
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--ls-remote-fixture') fixture = JSON.parse(fs.readFileSync(rest[++i], 'utf8'));
    else return fail(`unknown arg: ${rest[i]}`);
  }
  if (!manifestPath) return fail('usage: resolve-refs.js <clone-manifest.json> [--ls-remote-fixture <file>]');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, '')); } catch (e) { return fail(`cannot read manifest: ${e.message}`); }
  const lsRemote = fixture
    ? (url) => { if (!(url in fixture)) throw new Error('no fixture for ' + url); return fixture[url]; }
    : (url) => execFileSync('git', ['ls-remote', '--symref', url, 'HEAD', 'refs/heads/*', 'refs/tags/*'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000, maxBuffer: 64 * 1024 * 1024 });
  try {
    process.stdout.write(JSON.stringify(resolveManifest(manifest, lsRemote), null, 2) + '\n');
    return 0;
  } catch (e) { return fail(e.message); }
}

function fail(msg) { process.stdout.write(JSON.stringify({ ok: false, errors: [{ error: msg }] }) + '\n'); return 2; }

module.exports = { parseLsRemote, parseTag, compareTags, highestTag, resolveRepo, resolveManifest, CHANNEL_RE };
if (require.main === module) process.exitCode = main(process.argv.slice(2));

// AIFS:FILE-END
