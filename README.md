# Package Sus Detector - GitHub Action

Checks the npm and PyPI packages a pull request adds or changes, using the Apify Actor
[stormy251/package-sus-detector](https://apify.com/stormy251/package-sus-detector) ($0.01 per package checked, billed to your Apify account).
It flags names that do not exist (slopsquatting / hallucinated packages), typosquats, known vulnerabilities and deprecated packages, writes a report to the job summary and fails the job when the gate trips.

## Use
1. Create an Apify API token and store it as the repository secret `APIFY_TOKEN`.
2. Add `examples/package-sus-detector.yml` to `.github/workflows/`.

Auto-detects `package-lock.json`, `npm-shrinkwrap.json`, `yarn.lock`, `pnpm-lock.yaml`, `poetry.lock`, `uv.lock`, `Pipfile.lock` and `requirements.txt`. With a pull request it diffs against the base branch (`git show origin/<base>:<file>`), so only new or changed package versions are charged. `actions/checkout` needs `fetch-depth: 0`.

| Input | Default | Notes |
| --- | --- | --- |
| `apify-token` | required | Use a secret |
| `fail-on` | `suspicious` | `never`, `caution`, `suspicious`, `not_found` |
| `fail-on-risk-score` | none | 1-100 |
| `max-total-charge-usd` | `2` | Hard cap per Actor run |
| `max-packages` | `200` | Packages checked per file |
| `include-dev-dependencies` | `true` | |
| `lockfiles`, `requirements` | auto-detect | Newline-separated paths |
| `base-ref` | PR base branch | |
| `fail-on-error` | `false` | By default an Actor failure only warns; set true to block on it |
| `dry-run` | `false` | Print what would be sent, no call and no cost |

Outputs: `passed`, `failing-count`, `packages-checked`. Exit codes: 0 pass, 1 gate failed, 2 misconfiguration (or Actor failure with `fail-on-error`).

## Cost
Each package checked costs $0.01 on your own Apify account (pay-per-event). Only added or changed package versions are checked on pull requests, so a typical PR costs a few cents. `max-total-charge-usd` (default `2`) is a hard cap per run. Use `dry-run: 'true'` to see what would be sent without any call or cost.

## Security notes
- Pass the token only as a repository secret. The Action never prints it.
- The Action sends package names and versions (not your source code) to the Apify Actor, which queries the public npm, PyPI, OSV and deps.dev APIs. It never downloads or runs package code.
- Results are risk signals, not accusations: a `suspicious` or `not_found` verdict means "look closer before merging". A clean result is not a guarantee of safety.
- On fork pull requests GitHub does not expose secrets, so the check cannot run there.

## Status
v1.0.0. Tested with a mocked Apify client (`npm test`), a dry run against a real git repository, and one live run against the hosted Actor on a two-package PR diff (gate failed correctly; 2 packages charged). Marketplace listing is being set up manually.

## Licence
MIT. Source of the Actor itself: https://github.com/stormy251/package-sus-detector
