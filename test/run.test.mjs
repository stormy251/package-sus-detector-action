import test from 'node:test';
import assert from 'node:assert/strict';
import { run, readConfig, buildJobs, newRequirementLines } from '../run.mjs';

const mkClient = (summaryFor, calls) => class {
    constructor(opts) { this.opts = opts; }
    actor(id) { return { call: async (input, options) => { calls.push({ id, input, options, token: this.opts.token }); return { id: 'run1', status: input.__fail ? 'FAILED' : 'SUCCEEDED', defaultKeyValueStoreId: 'kv1' }; } }; }
    keyValueStore() { return { getRecord: async () => ({ value: summaryFor(calls[calls.length - 1].input) }) }; }
};
const passSummary = { totalChecked: 3, chargedPackages: 3, markdown: '### ok', gate: { enabled: true, passed: true, failingCount: 0, failing: [], complete: true } };
const failSummary = { totalChecked: 2, chargedPackages: 2, markdown: '### bad', gate: { enabled: true, passed: false, failingCount: 1, complete: true, failing: [{ ecosystem: 'npm', name: 'evil-pkg', version: '1.0.0', reason: 'verdict not_found', summary: 'Not found' }] } };

const files = { 'package-lock.json': '{"lockfileVersion":3}', 'poetry.lock': '[[package]]', 'requirements.txt': 'requests==2.31.0\nnew-dep==1.0\n# c\n' };
const fs = { exists: (p) => p in files, read: (p) => files[p], show: (ref, p) => (ref && p === 'package-lock.json' ? '{"lockfileVersion":3,"old":1}' : ref && p === 'requirements.txt' ? 'requests==2.31.0 # pinned\n' : '') };
const out = () => { const l = []; return { l, deps: { log: (m) => l.push(m), warn: (m) => l.push(`W:${m}`), error: (m) => l.push(`E:${m}`), append: (f, c) => l.push(`A:${f}:${c}`) } }; };

test('readConfig defaults and parsing', () => {
    const c = readConfig({ GITHUB_BASE_REF: 'main', PSD_FAIL_ON_RISK_SCORE: '60', PSD_LOCKFILES: 'a\n\n b ', PSD_DRY_RUN: 'true' });
    assert.equal(c.baseRef, 'origin/main');
    assert.equal(c.failOn, 'suspicious');
    assert.equal(c.failOnRiskScore, 60);
    assert.deepEqual(c.lockfiles, ['a', 'b']);
    assert.equal(c.dryRun, true);
    assert.equal(c.maxTotalChargeUsd, 2);
    assert.equal(c.includeDev, true);
});

test('newRequirementLines ignores unchanged lines and comments', () => {
    assert.equal(newRequirementLines('a==1\nb==2 # x\n#c\n', 'a==1\n'), 'b==2 # x');
});

test('buildJobs auto-detects lockfiles and diffs against base', () => {
    const jobs = buildJobs(readConfig({ GITHUB_BASE_REF: 'main', PSD_REQUIREMENTS: 'requirements.txt' }), fs);
    assert.deepEqual(jobs.map((j) => j.label), ['package-lock.json', 'poetry.lock', 'requirements.txt']);
    assert.ok(jobs[0].diffed && jobs[0].input.baseLockfile);
    assert.ok(!jobs[1].diffed && !('baseLockfile' in jobs[1].input));
    assert.equal(jobs[2].input.requirementsTxt, 'new-dep==1.0');
});

test('run: pass path sends gate options, token and charge cap, writes summary and outputs', async () => {
    const calls = []; const o = out();
    const r = await run({ env: { PSD_APIFY_TOKEN: 'tok_secret', GITHUB_BASE_REF: 'main', GITHUB_STEP_SUMMARY: 'S', GITHUB_OUTPUT: 'O', PSD_LOCKFILES: 'package-lock.json' }, deps: { ...o.deps, fs, ApifyClient: mkClient(() => passSummary, calls) } });
    assert.equal(r.exitCode, 0);
    assert.equal(r.passed, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].id, 'stormy251/package-sus-detector');
    assert.equal(calls[0].token, 'tok_secret');
    assert.deepEqual(calls[0].options, { maxTotalChargeUsd: 2 });
    assert.equal(calls[0].input.failOn, 'suspicious');
    assert.equal(calls[0].input.maxPackages, 200);
    assert.ok(calls[0].input.baseLockfile);
    assert.ok(o.l.some((x) => x.startsWith('A:S:') && x.includes('### ok')));
    assert.ok(o.l.some((x) => x.startsWith('A:O:') && x.includes('passed=true') && x.includes('packages-checked=3')));
    assert.ok(!o.l.join('\n').includes('tok_secret'));
});

test('run: failing gate exits 1 and lists failing packages', async () => {
    const calls = []; const o = out();
    const r = await run({ env: { PSD_APIFY_TOKEN: 't', PSD_LOCKFILES: 'package-lock.json', PSD_FAIL_ON_RISK_SCORE: '50' }, deps: { ...o.deps, fs, ApifyClient: mkClient(() => failSummary, calls) } });
    assert.equal(r.exitCode, 1);
    assert.equal(r.passed, false);
    assert.equal(r.failingCount, 1);
    assert.equal(calls[0].input.failOnRiskScore, 50);
    assert.ok(o.l.some((x) => x.includes('FAIL npm:evil-pkg@1.0.0')));
});

test('run: missing token fails with exit 2 and never calls Apify', async () => {
    const calls = []; const o = out();
    const r = await run({ env: { PSD_LOCKFILES: 'package-lock.json' }, deps: { ...o.deps, fs, ApifyClient: mkClient(() => passSummary, calls) } });
    assert.equal(r.exitCode, 2);
    assert.equal(calls.length, 0);
});

test('run: Actor failure only warns by default, blocks with fail-on-error', async () => {
    const calls = []; const o = out();
    const Failing = class { actor() { return { call: async () => { throw new Error('boom token=abc123'); } }; } };
    const soft = await run({ env: { PSD_APIFY_TOKEN: 't', PSD_LOCKFILES: 'package-lock.json' }, deps: { ...out().deps, fs, ApifyClient: Failing } });
    assert.equal(soft.exitCode, 0);
    const hard = await run({ env: { PSD_APIFY_TOKEN: 't', PSD_LOCKFILES: 'package-lock.json', PSD_FAIL_ON_ERROR: 'true', GITHUB_STEP_SUMMARY: 'S' }, deps: { ...o.deps, fs, ApifyClient: Failing } });
    assert.equal(hard.exitCode, 2);
    assert.ok(!o.l.join('\n').includes('abc123'));
    void calls;
});

test('run: dry run makes no call and needs no token', async () => {
    const calls = []; const o = out();
    const r = await run({ env: { PSD_DRY_RUN: 'true', GITHUB_BASE_REF: 'main' }, deps: { ...o.deps, fs, ApifyClient: mkClient(() => passSummary, calls) } });
    assert.equal(r.exitCode, 0);
    assert.equal(calls.length, 0);
    assert.ok(o.l.some((x) => x.includes('dry run')));
});

test('run: nothing to check warns and passes', async () => {
    const o = out();
    const r = await run({ env: { PSD_APIFY_TOKEN: 't' }, deps: { ...o.deps, fs: { exists: () => false, read: () => '', show: () => '' } } });
    assert.equal(r.exitCode, 0);
    assert.ok(o.l.some((x) => x.startsWith('W:No lockfile')));
});
