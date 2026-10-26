#!/usr/bin/env node
// Package Sus Detector GitHub Action runner. Reads PSD_* env vars (set by action.yml), calls the Apify Actor once per lockfile,
// writes a markdown report to the job summary and exits 1 when the gate fails.
import { existsSync, readFileSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const LOCKFILE_CANDIDATES = ['package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'poetry.lock', 'uv.lock', 'Pipfile.lock'];
const MAX_BYTES = 8 * 1024 * 1024;

export const mask = (m) => String(m).replace(/token=[^&\s]+/gi, 'token=***');
export const lines = (v) => String(v || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
const bool = (v, d = false) => (v === undefined || v === '' ? d : /^(1|true|yes)$/i.test(String(v)));

export function readConfig(env = process.env) {
    const num = (v) => (v !== undefined && v !== '' && Number.isFinite(Number(v)) ? Number(v) : null);
    return {
        token: env.PSD_APIFY_TOKEN || '',
        actor: env.PSD_ACTOR || 'stormy251/package-sus-detector',
        lockfiles: lines(env.PSD_LOCKFILES),
        requirements: lines(env.PSD_REQUIREMENTS),
        baseRef: env.PSD_BASE_REF || (env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : ''),
        failOn: env.PSD_FAIL_ON || 'suspicious',
        failOnRiskScore: num(env.PSD_FAIL_ON_RISK_SCORE),
        includeDev: bool(env.PSD_INCLUDE_DEV, true),
        maxPackages: num(env.PSD_MAX_PACKAGES) ?? 200,
        maxTotalChargeUsd: num(env.PSD_MAX_TOTAL_CHARGE_USD) ?? 2,
        failOnError: bool(env.PSD_FAIL_ON_ERROR, false),
        dryRun: bool(env.PSD_DRY_RUN, false),
    };
}

/** Content of `path` at git ref, or '' if missing (new file, no history, shallow clone). */
export function gitShow(ref, path, exec = execFileSync) {
    if (!ref) return '';
    try { return String(exec('git', ['show', `${ref}:${path}`], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] })); } catch { return ''; }
}

/** Only the requirement lines that are new compared with the base file (line-level diff, comments ignored). */
export function newRequirementLines(head, base) {
    const norm = (l) => l.replace(/^\s*#.*$/, '').replace(/\s+#.*$/, '').trim();
    const known = new Set(String(base || '').split(/\r?\n/).map(norm).filter(Boolean));
    return String(head).split(/\r?\n/).filter((l) => { const n = norm(l); return n && !known.has(n); }).join('\n');
}

export function buildJobs(cfg, { exists = existsSync, read = (p) => readFileSync(p, 'utf8'), show = gitShow } = {}) {
    const jobs = [];
    const paths = cfg.lockfiles.length ? cfg.lockfiles : LOCKFILE_CANDIDATES.filter((p) => exists(p));
    for (const p of paths) {
        if (!exists(p)) { jobs.push({ label: p, error: `${p} not found` }); continue; }
        const head = read(p);
        const base = show(cfg.baseRef, p);
        const input = { lockfile: head, ...(base ? { baseLockfile: base } : {}) };
        jobs.push({ label: p, input, diffed: Boolean(base), bytes: head.length + base.length });
    }
    for (const p of cfg.requirements) {
        if (!exists(p)) { jobs.push({ label: p, error: `${p} not found` }); continue; }
        const head = read(p);
        const base = show(cfg.baseRef, p);
        const text = base ? newRequirementLines(head, base) : head;
        if (!text.trim()) { jobs.push({ label: p, skipped: 'no new requirement lines' }); continue; }
        jobs.push({ label: p, input: { requirementsTxt: text }, diffed: Boolean(base), bytes: text.length });
    }
    return jobs;
}

export async function run({ env = process.env, deps = {} } = {}) {
    const log = deps.log || ((m) => console.log(m));
    const warn = deps.warn || ((m) => console.log(`::warning::${m}`));
    const error = deps.error || ((m) => console.log(`::error::${m}`));
    const cfg = readConfig(env);
    const result = { passed: true, failingCount: 0, packagesChecked: 0, exitCode: 0, markdown: [] };
    const jobs = buildJobs(cfg, deps.fs);
    if (!jobs.length) {
        warn('No lockfile or requirements file found to check. Set the "lockfiles" or "requirements" input.');
        return finish(result, env, deps);
    }
    if (!cfg.dryRun && !cfg.token) { error('apify-token is empty. Add an APIFY_TOKEN repository secret and pass it as apify-token.'); result.exitCode = 2; result.passed = false; return finish(result, env, deps); }
    let client = null;
    if (!cfg.dryRun) {
        const ApifyClient = deps.ApifyClient || (await import('apify-client')).ApifyClient;
        client = new ApifyClient({ token: cfg.token });
    }
    for (const job of jobs) {
        if (job.skipped) { log(`${job.label}: ${job.skipped}, skipping.`); continue; }
        if (job.error) { warn(job.error); if (cfg.failOnError) { result.exitCode = 2; result.passed = false; } continue; }
        if (job.bytes > MAX_BYTES) { warn(`${job.label} is larger than 8 MB; skipped. Use the "base-ref" diff or check fewer packages.`); if (cfg.failOnError) { result.exitCode = 2; result.passed = false; } continue; }
        const input = { ...job.input, failOn: cfg.failOn, maxPackages: cfg.maxPackages, includeDevDependencies: cfg.includeDev, includeSummaryItem: true, ...(cfg.failOnRiskScore ? { failOnRiskScore: cfg.failOnRiskScore } : {}) };
        log(`${job.label}: ${job.diffed ? 'checking packages added or changed since ' + cfg.baseRef : 'checking every package (no base to diff against)'}; cap ${cfg.maxPackages} packages, max charge $${cfg.maxTotalChargeUsd}.`);
        if (cfg.dryRun) { log(`  dry run: would call ${cfg.actor} with ${Object.keys(input).join(', ')} (${job.bytes} bytes of lockfile text).`); continue; }
        try {
            const runInfo = await client.actor(cfg.actor).call(input, { maxTotalChargeUsd: cfg.maxTotalChargeUsd });
            if (runInfo.status !== 'SUCCEEDED') throw new Error(`Actor run ${runInfo.id} ended with status ${runInfo.status}`);
            const rec = await client.keyValueStore(runInfo.defaultKeyValueStoreId).getRecord('SUMMARY');
            const summary = rec?.value;
            if (!summary?.gate) throw new Error('Actor run finished without a SUMMARY record (is the Actor version older than 0.1?)');
            result.packagesChecked += summary.chargedPackages ?? summary.totalChecked ?? 0;
            result.markdown.push(`#### ${job.label}\n${summary.markdown}`);
            for (const f of summary.gate.failing || []) log(`  FAIL ${f.ecosystem}:${f.name}${f.version ? '@' + f.version : ''} (${f.reason}): ${f.summary || ''}`);
            log(`  ${job.label}: ${summary.totalChecked} checked, gate ${summary.gate.enabled ? (summary.gate.passed ? 'passed' : 'FAILED') : 'off (report only)'}${summary.gate.complete === false ? ', INCOMPLETE (some packages not checked)' : ''}.`);
            if (!summary.gate.passed) { result.passed = false; result.failingCount += summary.gate.failingCount; result.exitCode = Math.max(result.exitCode, 1); }
        } catch (e) {
            const msg = mask(`${job.label}: Package Sus Detector call failed: ${e?.message || e}`);
            if (cfg.failOnError) { error(msg); result.passed = false; result.exitCode = Math.max(result.exitCode, 2); } else warn(`${msg} (continuing; set fail-on-error: true to block on this)`);
            result.markdown.push(`#### ${job.label}\nCheck did not complete: ${mask(e?.message || e)}`);
        }
    }
    return finish(result, env, deps);
}

function finish(result, env, deps) {
    const append = deps.append || appendFileSync;
    if (result.markdown.length && env.GITHUB_STEP_SUMMARY) append(env.GITHUB_STEP_SUMMARY, `${result.markdown.join('\n\n')}\n`);
    if (env.GITHUB_OUTPUT) append(env.GITHUB_OUTPUT, `passed=${result.passed}\nfailing-count=${result.failingCount}\npackages-checked=${result.packagesChecked}\n`);
    return result;
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
    run().then((r) => { process.exitCode = r.exitCode; }).catch((e) => { console.log(`::error::${e?.message || e}`); process.exitCode = 2; });
}
