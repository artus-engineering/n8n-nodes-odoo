# CI (GitHub Actions)

Runner: `ubuntu-latest` (public repo). Cross-project tooling: [Repository Tooling (SonarQube, CI, Cursor Agents)](https://github.com/artus-engineering/agency-portal/blob/main/docs/dev-tooling.md) — also in the Artus portal wiki under SWE → Wissen → Software Engineering.

## Workflows

| File | Purpose |
| --- | --- |
| `.github/workflows/branch.yaml` | Biome lint, n8n node/credential lint, type check, build, unit tests, package-content check, official n8n scan → SonarQube scan → quality gate |
| `.github/workflows/publish.yaml` | On a published GitHub Release: lint, type check, build, test, package checks, `npm publish --provenance`, GitHub Packages mirror |

## Required checks

On `main`:

- **Tests**
- **SonarQube Scan**

The quality gate runs inside the **SonarQube Scan** job — a failed gate fails that check.

Secrets: `SONAR_TOKEN`, `SONAR_HOST_URL`.

Fork PRs run the Tests job, including both linters, type checking, build, coverage, package-content validation and the official community scanner. The SonarQube job is skipped because GitHub does not expose repository secrets to forks. A maintainer must bring a reviewed contribution onto a trusted repository branch and obtain a passing SonarQube gate before merging. Never switch to `pull_request_target` to expose secrets to contributor code.

All jobs have bounded timeouts and read-only repository access unless publishing or PR decoration requires more. The npm scanner is pinned as a development dependency and scans both source and the files npm would publish. `pnpm run check` runs the complete local suite.

PRs use the `pull_request` event so tests and Sonar analyze the PR head. `pull_request_target` checks out the base branch (`main`), and the community branch plugin then records the run as `branch=main` — the quality gate fails on existing main issues and never sees the PR fixes.

## Publishing and npm provenance

`publish.yaml` publishes with `npm publish --provenance --access public` using npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (GitHub OIDC) — no `NPM_TOKEN` secret, and `NODE_AUTH_TOKEN` must never be set in that step (it overrides OIDC authentication).

This is not just an org convention here: from **1 May 2026**, n8n requires community nodes submitted for verification to be published via a GitHub Actions workflow with a provenance statement, and will not accept nodes published from a local machine. Publishing only ever happens through this workflow, triggered by a GitHub Release — never via a local `npm publish`.

## n8n node lint

`pnpm run lint:n8n` runs `n8n-node lint` (ESLint + `eslint-plugin-n8n-nodes-base` + `@n8n/eslint-plugin-community-nodes`, all shipped by `@n8n/node-cli`). This checks n8n-specific structural rules (credential/node shape, sensitive-field handling, action/display-name casing, forbidden lifecycle scripts) that Biome doesn't know about. It is a separate check from `pnpm run lint` (Biome, which owns all formatting and general TypeScript linting) — see [AGENTS.md](../AGENTS.md).

`package.json#n8n.strict` is `true`, which requires `eslint.config.mjs` to stay byte-identical to `@n8n/node-cli`'s default template. Do not edit that file.

## Package checks and release verification

`pnpm run check:package` must follow the build. It checks the npm file list for compiled node/credential entries, codex metadata and both icons, rejects stray documentation/build assets and obsolete Loki credential artifacts, and checks that the built metadata matches `package.json`. It then runs `@n8n/scan-community-package` against the local source and compiled output.

A local scan cannot verify npm provenance or the attested release source. After publishing, run the same scanner against the exact released version:

```bash
pnpm exec scan-community-package @artus-engineering/n8n-nodes-odoo@0.2.0
```

Replace `0.2.0` with the actual release version. This checks the published provenance and source as well. Passing these checks does not constitute approval in the n8n Creator Portal.

The release workflow receives its version through an environment variable before passing it to `npm version`, rather than interpolating event text into shell code. It publishes npm packages only on the release event. Manual dispatch is reserved for the existing GitHub Packages backfill flow and builds the selected workflow ref; select the release tag when backfilling a released version.

Keep the npm Trusted Publisher configured for this repository and `publish.yaml`. Use the workflow's Node.js 24 runtime with an npm version that supports Trusted Publishing. The npm step must not set `NODE_AUTH_TOKEN`; GitHub Packages authentication is scoped to its own step.

## Dependency audit

Run `pnpm audit` when updating dependencies. The community package has no runtime dependencies; development tooling still has a transitive dependency tree.

As of 21 November 2026, the n8n development dependencies require `zod@3.25.76`, which is covered by [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The advisory's patched version is Zod 4.6.6; no patched Zod 3 release is available. Do not force Zod 4 into packages expecting the Zod 3 API. This finding remains visible to audit until upstream tooling supports a compatible fix. It is not bundled in this package; runtime `n8n-workflow` is supplied by the host n8n installation.

The scanner's vulnerable `tmp` dependency is upgraded to a compatible patched version through `pnpm-workspace.yaml`.
