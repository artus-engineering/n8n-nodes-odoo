# Contributing

Thank you for contributing to `@artus-engineering/n8n-nodes-odoo`. Bug fixes, documentation, examples and focused improvements are welcome. Participation follows our [Code of Conduct](CODE_OF_CONDUCT.md).

## Report an issue

Search [existing issues](https://github.com/artus-engineering/n8n-nodes-odoo/issues) before opening a new one. Include the package, n8n and Odoo versions, a minimal reproduction, and the expected and actual behaviour. Remove credentials, customer data and private URLs from workflow exports and logs.

Report security vulnerabilities privately as described in [SECURITY.md](SECURITY.md).

## Set up the project

Use Node.js 24 and the exact pnpm version in `package.json#packageManager` (currently `12.21.0`). Install that pnpm version using your preferred package-manager setup, then:

```bash
git clone https://github.com/artus-engineering/n8n-nodes-odoo.git
cd n8n-nodes-odoo
pnpm install --frozen-lockfile
pnpm run dev
```

For external contributions, fork the repository and clone your fork instead. `dev` starts a local n8n instance on port 5678 with the node linked. Use a test Odoo database for integration checks. Unit tests use fake HTTP responses and clocks and require no service credentials.

Lefthook installs the pre-commit formatter through its development dependency. If hooks are missing after installation, run `pnpm exec lefthook install`.

## Make and validate a change

Create a branch, keep changes focused, and add regression tests when behaviour changes. Update the README or examples when users need different configuration. [AGENTS.md](AGENTS.md) is the canonical guide to code layout, retries, error handling and tooling.

```bash
pnpm run check
```

The check command runs:

| Command | Checks |
| --- | --- |
| `pnpm run lint` | Biome formatting and general lint rules. |
| `pnpm run lint:n8n` | n8n's strict node and credential rules. |
| `pnpm run typecheck` | Production code and tests under strict TypeScript. |
| `pnpm run build` | Compilation, static files and distribution cleanup. |
| `pnpm run test` | Unit tests with coverage. |
| `pnpm run check:package` | npm file contents and the official n8n scanner on source and compiled code. Run after building. |

Use `pnpm run lint:fix` for formatting and `pnpm run test:watch` while developing. Do not add runtime dependencies, installation lifecycle scripts, or overrides to `eslint.config.mjs`; n8n requires the default strict configuration. Nodes must use credentials from their own package and at most one credential at a time. Logging integrations belong on the separate output.

Coverage must not regress on changed files. CI also runs SonarQube for trusted branches. Fork PRs run all local-equivalent checks without secrets; a maintainer must run SonarQube on a trusted branch before merging. See [docs/ci.md](docs/ci.md).

## Open a pull request

Describe the problem, resulting behaviour, validation and any migration users need. Link the related issue if there is one. Keep generated `dist/`, coverage and npm archives out of commits. Maintainers publish releases through GitHub Actions; opening a PR does not require publishing a package.

Contributions are licensed under this repository's [MIT license](LICENSE).
