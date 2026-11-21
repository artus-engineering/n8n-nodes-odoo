# AGENTS.md

Canonical contributor and AI-agent guide for `@artus-engineering/n8n-nodes-odoo`. Cursor rules in `.cursor/rules/*.mdc` (if added) should point here; keep this file as the single source of truth.

## Repository map

- `nodes/OdooJson2/OdooJson2.node.ts` — the node's `INodeType` implementation (`execute()`): reads parameters, wires HTTP, `/web/health` and cancellation-aware `sleep` into `sendWithWaiting`, shapes result/error items and a separate Outage Logs output.
- `nodes/OdooJson2/OdooJson2Description.ts` — the node's `INodeProperties[]` (UI form fields).
- `nodes/OdooJson2/GenericFunctions.ts` — pure, context-free core: response classification (405/503/connection refused = not delivered, 502/504/timeout = unclear), retry decision per method, the waiting loop `sendWithWaiting` with injected dependencies, record splitting and structured outage events. Unit-tested without n8n.
- `nodes/OdooJson2/OdooJson2.node.json` — the node's codex.
- `nodes/OdooJson2/odoo.svg`, `odoo.dark.svg` — light/dark node and credential icons.
- `credentials/OdooJson2Api.credentials.ts` — `odooJson2Api`: Odoo URL, database, API key (bearer); tested with `res.users/context_get`.
- `tests/` — Vitest unit tests.
- `scripts/clean-dist.mjs` — post-build cleanup (see "Build output" below).
- `scripts/check-package.mjs` — verifies npm package contents before the official n8n scanner.
- `examples/` — importable read-only workflows, including a separate Loki logging branch.

## Waiting behaviour

- HTTP 405/503 and refused/unresolvable connections never reached Odoo: always wait for `/web/health` to report `pass`, then resend.
- HTTP 502/504, timeouts and reset connections may come after Odoo executed the request: resend only when the method is retryable (`automatic`: read methods and `write`; never `create`, `unlink`, actions).
- Any other status is an Odoo error and goes straight to the caller.
- After `maxWaitMinutes` the request fails and the Odoo URL is remembered in a process-wide registry, so following requests fail at once instead of each waiting again; the registry is cleared as soon as `/web/health` passes.
- Waiting uses `sleep` from `n8n-workflow` with the execution cancellation signal (no `setTimeout`, see `no-restricted-globals`). Check cancellation before sending and after asynchronous health checks.
- A request shares one wait deadline across outage/recovery cycles. Polling sleeps are capped at the remaining budget; in-flight HTTP calls still have their own timeouts.
- The outage registry expires only when health passes or the process restarts, not after another wait interval.

## Logging contract

- Output 0 is Results; output 1 is Outage Logs. Keep Results compatible with existing workflows.
- Log items carry English event data under `json.log`, paired with the originating input item. Propagate an input item's `_lokiLogging` settings separately from the log payload so the Loki node can honor workflow defaults without logging headers.
- Events are buffered until `execute()` returns. Stop Workflow and cancellation prevent downstream delivery; Continue using regular output allows terminal outage events to reach Loki. The runtime logger receives events immediately at their matching level.
- Loki credentials, HTTP requests and workflow defaults belong to `@artus-engineering/n8n-nodes-loki`. Do not reintroduce a second credential or cross-package credential access here.
- Keep the existing Results error keys `methode` and `odoo_nicht_erreichbar` for compatibility. New log fields and all authored user-facing messages are English.

## n8n node/credential development

- This package must have **zero runtime dependencies** (`n8n-workflow` is a peer dependency only). n8n rejects community nodes that ship dependencies; use `this.helpers.httpRequestWithAuthentication` and other built-ins instead of adding an HTTP client.
- The node must not read environment variables or the filesystem — all configuration goes through node parameters or the credential.
- The official n8n scanner enforces one credential at a time and credentials owned by this package. Run it against the built package via `pnpm run check:package`.
- Every user-facing error must be a `NodeOperationError` or `NodeApiError` (never a raw `Error` that reaches n8n's execution engine). `GenericFunctions.ts` helpers take an `INode` for exactly this reason.
- `package.json#n8n.strict` is `true`. This requires `eslint.config.mjs` to stay **byte-identical** to `@n8n/node-cli`'s default template (`import { config } from '@n8n/node-cli/eslint'; export default config;`) — do not add overrides or ignores there. If a false-positive from `n8n-node lint` needs working around, prefer restructuring the code over touching the lint config.
- `n8n-node lint`'s `isOption`/title-case heuristic flags any object literal with exactly `{ name, value }` keys, including default values for Name/Value `fixedCollection` fields — not just genuine `INodePropertyOptions` entries. Keep such defaults empty (`default: {}`) rather than pre-filling a row, both to sidestep the false positive and for consistency with the node's other fixedCollection fields.

## Build output

`n8n-node build` (`tsc` + copy `**/*.{png,svg}` and `**/__schema__/**/*.json`) globs those extensions across the **whole repository**, only excluding `dist` and `node_modules` — there's no way to scope it further. `pnpm run build` therefore runs `scripts/clean-dist.mjs` afterwards, which deletes everything under `dist/` except `nodes/`, `credentials/`, and `package.json`. If you add a new top-level output n8n needs (rare), update that allowlist.

## Testing

- Vitest, `coverage-v8`, `lcovonly` output to `coverage/lcov.info` (uploaded to SonarQube by CI). Do not use the `lcov` reporter — it also writes an HTML report under `coverage/lcov-report/` whose generated JS files trip `n8n-node lint`.
- `tests/GenericFunctions.test.ts` covers the pure core, including the waiting loop with a fake clock.
- `tests/OdooJson2.node.test.ts` stubs a minimal `IExecuteFunctions` and asserts on requests, result items, error items, log items and cancellation.
- `tests/Credentials.test.ts` covers the Odoo credential.
- Do not regress coverage on changed files.

## Conventions

- **pnpm** for package management; **Biome** owns formatting and general TypeScript linting (`pnpm run lint` / `pnpm run lint:fix`) — do not introduce ESLint rules for anything Biome already covers. `pnpm run lint:n8n` (`n8n-node lint`) is a separate, n8n-specific structural check; both must pass.
- **Lefthook** formats and lints staged files on commit (`lefthook.yml`); the `lefthook` package installs it automatically via its own `postinstall` when you run `pnpm install` (no custom `prepare` script — community node packages must not carry lifecycle scripts, since those would also run for anyone who installs this package as an n8n dependency).
- **SonarQube:** SonarLint Connected Mode + MCP analysis on changed `*.ts` files before agent commits (tool priority: `analyze_file_list` → `run_advanced_code_analysis` if present → `analyze_code_snippet` last resort). Lefthook/Biome is not a substitute.
- Cross-project tooling guide: Artus portal wiki **Repository Tooling (SonarQube, CI, Cursor Agents)** or [agency-portal `docs/dev-tooling.md`](https://github.com/artus-engineering/agency-portal/blob/main/docs/dev-tooling.md).
- No comments that narrate code (`// Import X`, `// Set Y`). Keep comments for non-obvious intent, constraints, or trade-offs only.
- Avoid adding emojis to code or comments unless explicitly requested.

## Commands cheatsheet

```bash
pnpm install                 # workspace install (also installs the pre-commit hook)
pnpm run lint                # biome check
pnpm run lint:fix            # biome check --write
pnpm run lint:n8n            # n8n-node lint (structural node/credential rules)
pnpm run typecheck           # tsc --noEmit
pnpm run test                # vitest + coverage
pnpm run test:watch          # vitest --watch
pnpm run build               # n8n-node build + dist cleanup
pnpm run check:package       # package contents + official n8n scanner (after build)
pnpm run check               # all pre-PR checks
pnpm run dev                 # n8n-node dev — launches n8n on :5678 with this node hot-linked
```

## Pre-PR checklist

Run locally before pushing:

- [ ] `pnpm run lint`
- [ ] `pnpm run lint:n8n`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run build`
- [ ] `pnpm run test`
- [ ] `pnpm run check:package`

CI (`.github/workflows/branch.yaml`) enforces all of the above on `ubuntu-latest` (public repo). Trusted branches also run the SonarQube scan and quality gate; fork PRs have no Sonar secrets and require a maintainer to run that analysis on a trusted branch before merging.

Dependency updates must preserve the zero-runtime-dependency rule and pass the same checks as source changes.

## Publishing

Releases are driven by GitHub Releases, not local npm scripts. See `.github/workflows/publish.yaml` and [docs/ci.md](docs/ci.md).

To cut a release:

1. Ensure `main` is green.
2. Create a GitHub Release with a semver tag, e.g. `v0.2.0` (leading `v` is stripped automatically).
3. The workflow sets `package.json` version from the release tag, runs `lint` → `lint:n8n` → `typecheck` → `build` → `test` → `check:package`, and publishes `@artus-engineering/n8n-nodes-odoo` to the public npm registry with `npm publish --provenance`.

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) via the GitHub connection configured on npmjs.com for `publish.yaml`. No `NPM_TOKEN` secret is required. Do not set `NODE_AUTH_TOKEN` in the publish step — it overrides OIDC authentication. This also satisfies n8n's requirement (mandatory from 1 May 2026) that verified community nodes be published via GitHub Actions with an npm provenance statement.

### n8n community node verification

To submit this package to the [n8n Creator Portal](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/) for the verified badge / n8n Cloud availability, after a release:

```bash
npx @n8n/scan-community-package @artus-engineering/n8n-nodes-odoo
```
