# AGENTS.md

Canonical contributor and AI-agent guide for `@artus-engineering/n8n-nodes-odoo`. Cursor rules in `.cursor/rules/*.mdc` (if added) should point here; keep this file as the single source of truth.

## Repository map

- `nodes/OdooJson2/OdooJson2.node.ts` — the node's `INodeType` implementation (`execute()`): reads parameters, wires HTTP, `/web/health`, `sleep` and the Loki push into `sendWithWaiting`, shapes output and error items like the HTTP Request node.
- `nodes/OdooJson2/OdooJson2Description.ts` — the node's `INodeProperties[]` (UI form fields).
- `nodes/OdooJson2/GenericFunctions.ts` — pure, context-free core: response classification (405/503/connection refused = not delivered, 502/504/timeout = unclear), retry decision per method, the waiting loop `sendWithWaiting` with injected dependencies, record splitting, Loki payload. Unit-tested without n8n.
- `nodes/OdooJson2/OdooJson2.node.json` — the node's codex.
- `nodes/OdooJson2/odoo.svg`, `loki.svg` — node and credential icons.
- `credentials/OdooJson2Api.credentials.ts` — `odooJson2Api`: Odoo URL, database, API key (bearer); tested with `res.users/context_get`.
- `credentials/OdooLokiApi.credentials.ts` — `odooLokiApi`: same fields as `lokiApi` of `@artus-engineering/n8n-nodes-loki`. A separate type is required because `no-credential-reuse` forbids credentials from other packages.
- `tests/` — Vitest unit tests.
- `scripts/clean-dist.mjs` — post-build cleanup (see "Build output" below).

## Waiting behaviour

- HTTP 405/503 and refused/unresolvable connections never reached Odoo: always wait for `/web/health` to report `pass`, then resend.
- HTTP 502/504, timeouts and reset connections may come after Odoo executed the request: resend only when the method is retryable (`automatic`: read methods and `write`; never `create`, `unlink`, actions).
- Any other status is an Odoo error and goes straight to the caller.
- After `maxWaitMinutes` the request fails and the Odoo URL is remembered in a process-wide registry, so following requests fail at once instead of each waiting again; the registry is cleared as soon as `/web/health` passes.
- Waiting uses `sleep` from `n8n-workflow` (no `setTimeout`, see `no-restricted-globals`) and stops when the execution is cancelled.

## n8n node/credential development

- This package must have **zero runtime dependencies** (`n8n-workflow` is a peer dependency only). n8n rejects community nodes that ship dependencies; use `this.helpers.httpRequestWithAuthentication` and other built-ins instead of adding an HTTP client.
- The node must not read environment variables or the filesystem — all configuration goes through node parameters or the credential.
- Every user-facing error must be a `NodeOperationError` or `NodeApiError` (never a raw `Error` that reaches n8n's execution engine). `GenericFunctions.ts` helpers take an `INode` for exactly this reason.
- `package.json#n8n.strict` is `true`. This requires `eslint.config.mjs` to stay **byte-identical** to `@n8n/node-cli`'s default template (`import { config } from '@n8n/node-cli/eslint'; export default config;`) — do not add overrides or ignores there. If a false-positive from `n8n-node lint` needs working around, prefer restructuring the code over touching the lint config.
- `n8n-node lint`'s `isOption`/title-case heuristic flags any object literal with exactly `{ name, value }` keys, including default values for Name/Value `fixedCollection` fields — not just genuine `INodePropertyOptions` entries. Keep such defaults empty (`default: {}`) rather than pre-filling a row, both to sidestep the false positive and for consistency with the node's other fixedCollection fields.

## Build output

`n8n-node build` (`tsc` + copy `**/*.{png,svg}` and `**/__schema__/**/*.json`) globs those extensions across the **whole repository**, only excluding `dist` and `node_modules` — there's no way to scope it further. `pnpm run build` therefore runs `scripts/clean-dist.mjs` afterwards, which deletes everything under `dist/` except `nodes/`, `credentials/`, and `package.json`. If you add a new top-level output n8n needs (rare), update that allowlist.

## Testing

- Vitest, `coverage-v8`, `lcovonly` output to `coverage/lcov.info` (uploaded to SonarQube by CI). Do not use the `lcov` reporter — it also writes an HTML report under `coverage/lcov-report/` whose generated JS files trip `n8n-node lint`.
- `tests/GenericFunctions.test.ts` covers the pure core, including the waiting loop with a fake clock.
- `tests/OdooJson2.node.test.ts` stubs a minimal `IExecuteFunctions` and asserts on requests, output items, error items and Loki pushes.
- `tests/Credentials.test.ts` covers both credentials.
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
pnpm run dev                 # n8n-node dev — launches n8n on :5678 with this node hot-linked
```

## Pre-PR checklist

Run locally before pushing:

- [ ] `pnpm run lint`
- [ ] `pnpm run lint:n8n`
- [ ] `pnpm run typecheck`
- [ ] `pnpm run build`
- [ ] `pnpm run test`

CI (`.github/workflows/branch.yaml`) enforces all of the above plus the SonarQube scan and quality gate on `ubuntu-latest` (public repo).

**Dependabot** runs yearly; weekly dependency maintenance is handled by Cursor Automation.

## Publishing

Releases are driven by GitHub Releases, not local npm scripts. See `.github/workflows/publish.yaml` and [docs/ci.md](docs/ci.md).

To cut a release:

1. Ensure `main` is green.
2. Create a GitHub Release with a semver tag, e.g. `v0.2.0` (leading `v` is stripped automatically).
3. The workflow sets `package.json` version from the release tag, runs `lint` → `lint:n8n` → `typecheck` → `build` → `test`, and publishes `@artus-engineering/n8n-nodes-odoo` to the public npm registry with `npm publish --provenance`.

Publishing uses [npm Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC) via the GitHub connection configured on npmjs.com for `publish.yaml`. No `NPM_TOKEN` secret is required. Do not set `NODE_AUTH_TOKEN` in the publish step — it overrides OIDC authentication. This also satisfies n8n's requirement (mandatory from 1 May 2026) that verified community nodes be published via GitHub Actions with an npm provenance statement.

### n8n community node verification

To submit this package to the [n8n Creator Portal](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/) for the verified badge / n8n Cloud availability, after a release:

```bash
npx @n8n/scan-community-package @artus-engineering/n8n-nodes-odoo
```
