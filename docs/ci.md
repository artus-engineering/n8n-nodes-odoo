# CI (GitHub Actions)

Runner: `ubuntu-latest` (public repo). Cross-project tooling: [Repository Tooling (SonarQube, CI, Cursor Agents)](https://github.com/artus-engineering/agency-portal/blob/main/docs/dev-tooling.md) — also in the Artus portal wiki under SWE → Wissen → Software Engineering.

## Workflows

| File | Purpose |
| --- | --- |
| `.github/workflows/branch.yaml` | Biome lint, n8n node/credential lint, type check, build, unit tests, package-content check, official n8n scan → SonarQube scan → quality gate |
| `.github/workflows/publish.yaml` | On a published GitHub Release: lint, type check, build, test, package checks, direct npm publication with provenance |

## Checks to require before release

On `main`:

- **Lint and format**
- **Typecheck**
- **Build** (including package checks)
- **Tests**
- **SonarQube Scan**

The quality gate runs inside the **SonarQube Scan** job — a failed gate fails that check. Verify all five jobs on the exact release commit; running these jobs in CI does not by itself make them required by GitHub branch rules.

Secrets: `SONAR_TOKEN`, `SONAR_HOST_URL`.

Fork PRs run the lint, typecheck, build and tests jobs, including coverage, package-content validation and the official community scanner. The SonarQube job is skipped because GitHub does not expose repository secrets to forks. A maintainer must bring a reviewed contribution onto a trusted repository branch and obtain a passing SonarQube gate before merging. Never switch to `pull_request_target` to expose secrets to contributor code.

All jobs have bounded timeouts and read-only repository access unless publishing or PR decoration requires more. The npm scanner is pinned as a development dependency and scans both source and the files npm would publish. `pnpm run check` runs the complete local suite.

PRs use the `pull_request` event so tests and Sonar analyze the PR head. `pull_request_target` checks out the base branch (`main`), and the community branch plugin then records the run as `branch=main` — the quality gate fails on existing main issues and never sees the PR fixes.

## Publishing and npm provenance

`publish.yaml` publishes directly to `https://registry.npmjs.org` with `npm publish --provenance --access public` using npm [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (GitHub OIDC). npm is the only publishing target; there is no GitHub Packages mirror or manual backfill workflow. `package.json#publishConfig` also selects the public npm registry. No `NPM_TOKEN` secret is required, and the publish step must not set `NODE_AUTH_TOKEN`.

The npm Trusted Publisher must name `artus-engineering/n8n-nodes-odoo` and `publish.yaml`, and must allow **npm publish**. Permission for **npm stage publish** alone does not authorize this workflow. A new trusted-publisher configuration must complete its first successful publish within two days; if it expires, recreate it before releasing. The restrictive 2FA/token setting remains compatible with OIDC.

This is not just an org convention here: from **1 May 2026**, n8n requires community nodes submitted for verification to be published via a GitHub Actions workflow with a provenance statement, and will not accept nodes published from a local machine. Publishing only ever happens through this workflow, triggered by a GitHub Release — never via a local `npm publish`.

## n8n node lint

`pnpm run lint:n8n` runs `n8n-node lint` (ESLint + `eslint-plugin-n8n-nodes-base` + `@n8n/eslint-plugin-community-nodes`, all shipped by `@n8n/node-cli`). This checks n8n-specific structural rules (credential/node shape, sensitive-field handling, action/display-name casing, forbidden lifecycle scripts) that Biome doesn't know about. It is a separate check from `pnpm run lint` (Biome, which owns all formatting and general TypeScript linting) — see [AGENTS.md](../AGENTS.md).

`package.json#n8n.strict` is `true`, which requires `eslint.config.mjs` to stay byte-identical to `@n8n/node-cli`'s default template. Do not edit that file.

## Package checks and release verification

`pnpm run check:package` must follow the build. It checks the npm file list for compiled node/credential entries, codex metadata and both icons, rejects stray documentation/build assets and obsolete Loki credential artifacts, and checks that the built metadata matches `package.json`. It then runs `@n8n/scan-community-package` against the local source and compiled output.

A local scan cannot verify npm provenance or the attested release source. After publishing, run the same scanner against the exact released version:

```bash
pnpm exec scan-community-package @artus-engineering/n8n-nodes-odoo@1.0.0
```

Replace `1.0.0` with the actual release version. This checks the published provenance and source as well. Passing these checks does not constitute approval in the n8n Creator Portal.

The release workflow validates the tag as a version and passes it through an environment variable to `npm version`, rather than interpolating event text into shell code. A tag such as `v1.0.0` publishes version `1.0.0`; the repository's development version does not need a separate bump. Stable releases use npm's default `latest` tag, retaining npm's check against publishing an older version as latest; GitHub prereleases and versions with a semver prerelease suffix use `next`. Jobs for the same release tag are serialized, and reruns skip a version already present on npm.

Before releasing v1, merge the release-readiness changes, verify all five CI jobs on the resulting `main` commit, and create a GitHub Release tagged `v1.0.0` at that commit. Use the workflow's Node.js 24 runtime with an npm version that supports Trusted Publishing. After the publish job succeeds, run the version-specific scan above.

## Dependency audit

Run `pnpm audit` when updating dependencies. The community package has no runtime dependencies; development tooling still has a transitive dependency tree.

As of 21 November 2026, the n8n development dependencies require `zod@3.25.76`, which is covered by [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5). The advisory's patched version is Zod 4.6.6; no patched Zod 3 release is available. Do not force Zod 4 into packages expecting the Zod 3 API. This finding remains visible to audit until upstream tooling supports a compatible fix. It is not bundled in this package; runtime `n8n-workflow` is supplied by the host n8n installation.

The scanner's vulnerable `tmp` dependency is upgraded to a compatible patched version through `pnpm-workspace.yaml`.
