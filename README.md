<div align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/artus-engineering/n8n-nodes-odoo/main/assets/artus-engineering-logo-white.svg" />
    <source media="(prefers-color-scheme: light)" srcset="https://raw.githubusercontent.com/artus-engineering/n8n-nodes-odoo/main/assets/artus-engineering-logo-black.svg" />
    <img alt="Artus Engineering" src="https://raw.githubusercontent.com/artus-engineering/n8n-nodes-odoo/main/assets/artus-engineering-logo-black.svg" width="400" />
  </picture>
</div>

<h1 align="center">n8n-nodes-odoo</h1>

<p align="center">
  An <a href="https://n8n.io">n8n</a> community node for the <a href="https://www.odoo.com/documentation/19.0/developer/reference/external_api.html">Odoo JSON-2 API</a>.
  Wait out outages, control retries and route outage events to your existing logging workflow.
</p>

<div align="center">
  <a href="https://www.npmjs.com/package/@artus-engineering/n8n-nodes-odoo"><img alt="NPM Version" src="https://img.shields.io/npm/v/%40artus-engineering%2Fn8n-nodes-odoo"></a>
  <a href="https://github.com/artus-engineering/n8n-nodes-odoo/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/License-MIT-8b5cf6"></a>
  <a href="https://github.com/artus-engineering/n8n-nodes-odoo/actions/workflows/branch.yaml"><img alt="CI Status" src="https://img.shields.io/github/actions/workflow/status/artus-engineering/n8n-nodes-odoo/.github%2Fworkflows%2Fbranch.yaml?label=CI&logo=GitHub"></a>
  <a href="https://sonar.artus-engineering.de/dashboard?id=artus-engineering_n8n-nodes-odoo_a0891ee7-354c-4ff3-97f2-e52cc08b6c53"><img alt="SonarQube" src="https://img.shields.io/badge/SonarQube-quality%20analysis-4e9bcd?logo=sonarqube"></a>
  <img alt="n8n community node" src="https://img.shields.io/badge/n8n-community--node-ea4b71?logo=n8n&logoColor=white">
</div>

<hr />

## Table of contents

- [Features](#features)
- [Compatibility](#compatibility)
- [Installation](#installation)
- [Credentials](#credentials)
- [Quick start](#quick-start)
- [Node reference](#node-reference)
- [Waiting and retry behaviour](#waiting-and-retry-behaviour)
- [Outputs](#outputs)
- [Logging with the separate Loki node](#logging-with-the-separate-loki-node)
- [Migration from built-in Loki logging](#migration-from-built-in-loki-logging)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Releases](#releases)
- [Contributing and support](#contributing-and-support)
- [License](#license)

## Features

- **JSON-2 calls** — call public model methods through `POST /json/2/<model>/<method>`, including reads, writes, creates and model actions.
- **Outage recovery** — poll `/web/health` before retrying unavailable requests.
- **Controlled retries** — distinguish delivery failures from ambiguous responses that may follow a committed operation.
- **Bounded waiting** — share one wait budget across retries and fail fast during an already recorded outage.
- **Familiar results** — one item per record, `{ data }` for scalar responses, or a full HTTP response.
- **Separate outage logs** — connect the second output to the [Artus Loki node](https://github.com/artus-engineering/n8n-nodes-loki) or another logging workflow.
- **Zero runtime dependencies** — use n8n's HTTP helpers and encrypted credentials; no environment or filesystem access in the node.

## Compatibility

- **Odoo 19 or later**, with the JSON-2 API and `/web/health` reachable from the n8n worker. This node does not use the older XML-RPC or JSON-RPC endpoints.
- An Odoo API key with access to the requested models. For Odoo Online, external API access requires a **Custom** plan; see the [Odoo API documentation](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html).
- A self-hosted n8n installation that allows community packages. n8n Cloud availability depends on separate [n8n verification](https://docs.n8n.io/integrations/creating-nodes/deploy/submit-community-nodes/); passing the package scanner does not grant that status.
- Development and CI use **Node.js 24** and the pnpm version pinned in `package.json`. The node is type-checked against the pinned `n8n-workflow` development dependency.

## Installation

### From the n8n GUI

Go to **Settings → Community Nodes → Install** and enter:

```text
@artus-engineering/n8n-nodes-odoo
```

### Self-hosted, via npm

Run as the user running n8n, in its community nodes directory:

```bash
mkdir -p ~/.n8n/nodes
cd ~/.n8n/nodes
npm install @artus-engineering/n8n-nodes-odoo
```

Restart n8n afterwards. Follow n8n's [manual installation guide](https://docs.n8n.io/integrations/community-nodes/installation/manual-install/) for Docker and queue-mode deployments; install the package on every worker that executes it.

## Credentials

Create an **Odoo JSON-2 API** credential:

| Field | Description |
| --- | --- |
| **Odoo URL** | Instance base URL, such as `https://odoo.example.com`. Do not include `/json/2`, embedded credentials, a query string or a fragment. |
| **Database** | Database name. This node requires it in either the credential or the node and sends it as `X-Odoo-Database`. |
| **API Key** | Odoo API key, stored as a secret and sent as a bearer token. |

Create an API key in the Odoo user's preferences under **Account Security → API Keys**. A dedicated integration user lets you limit access to the models the workflow needs. The credential test calls `res.users/context_get` with an empty JSON body.

The node's **Odoo URL** and **Database** parameters override the credential values when filled in. Loki credentials belong exclusively to the separate Loki node.

## Quick start

1. Add a **Manual Trigger** and an **Odoo JSON-2** node.
2. Select the Odoo credential.
3. Set **Model** to `res.partner` and **Method** to `search_read`.
4. Set **Body** to:

   ```json
   {
     "domain": [["is_company", "=", true]],
     "fields": ["name"],
     "limit": 10
   }
   ```

5. Execute the workflow. The **Results** output contains one item per matching company.

Import [Read companies](examples/read-companies.json) for this minimal workflow, or [Read companies with Loki logging](examples/read-companies-with-loki.json) for the logging setup. Both examples contain no credentials and perform read-only calls.

To update a record, use **Method** `write` and a body such as:

```json
{
  "ids": [42],
  "vals": { "name": "Example Company" }
}
```

Expressions can supply model names, methods and JSON bodies. JSON-2 takes named arguments directly; do not wrap them in a JSON-RPC `params` or `args` envelope. Available methods and fields depend on your Odoo database and installed modules.

## Node reference

| Parameter | Default | Description |
| --- | --- | --- |
| **Odoo URL** | Credential value | Optional instance override. |
| **Database** | Credential value | Optional database override. |
| **Model** | Required | Technical model name, such as `res.partner`. |
| **Method** | Required | Public method, such as `search_read`, `write` or `action_confirm`. |
| **Body** | `{}` | JSON object containing the method's named arguments. |
| **Retry After Unclear Failure** | `Automatic` | Retry read methods and `write`; choose `Always` or `Never` to override. |
| **Output** | `Records` | Shape of the Results output: records or full HTTP response. |

### Options

| Option | Default | Description |
| --- | --- | --- |
| **Max Wait (Minutes)** | `60` | Wait budget from the first outage, shared across retry cycles for one input item. |
| **Check Interval (Seconds)** | `30` | Delay between health checks, capped at the remaining wait budget. A final health check runs when the budget ends. |
| **Max Attempts** | `5` | Maximum JSON-2 sends, including the initial attempt; health checks do not count. |
| **Waiting Log Interval (Minutes)** | `5` | How often to record a still-waiting event. |
| **Timeout (Seconds)** | `120` | Timeout for each JSON-2 request. Health checks have a 10-second timeout. |

## Waiting and retry behaviour

| Response | Behaviour |
| --- | --- |
| `2xx` | Return the result. |
| `405`, `503`, refused/unresolvable/unreachable connection | Treat as not delivered, wait for health, then retry regardless of retry mode. |
| `502`, `504`, timeout, reset connection or broken pipe | Delivery is unclear. Wait and retry only if the method is retryable. |
| Any other response, including `401`, `403`, `422`, `429` and `500` | Return the error immediately. |

Health requires both a successful HTTP status and a body containing `{"status":"pass"}`. A redirect, HTML maintenance page, failed check or non-success status is not sufficient by itself.

`Automatic` retries `search_read`, `read`, `search`, `search_count`, `fields_get`, `name_search`, `read_group`, `web_search_read`, `web_read`, `default_get`, `check_access_rights`, `context_get` and `write`. It does not retry `create`, `unlink` or arbitrary actions after an unclear failure. `Always` can repeat a committed operation. Use `Never` for writes or custom read methods that trigger non-repeatable side effects.

The `405`/`503` policy assumes your gateway returns these statuses before dispatching to Odoo. Confirm that assumption for your deployment. A timeout or gateway error cannot prove that Odoo rolled back the operation.

When the wait budget expires, the node remembers the Odoo URL in the current worker process. Later requests check health once and fail without sending the JSON-2 request while the instance remains unhealthy. A successful health check clears the entry. The cache is not shared between workers and resets when a worker restarts.

Waiting occupies the workflow worker. Set the workflow execution timeout above the wait budget plus HTTP request time. An in-flight HTTP request can finish after the wait deadline. Cancelling an execution interrupts its polling sleep and prevents further retries; it cannot undo a request already sent to Odoo.

## Outputs

### Results

- **Records:** arrays become one item per element; objects remain objects; scalars become `{ "data": value }`. An empty array produces no result items.
- **Full Response:** one item containing `statusCode`, `headers` and `body`.
- Every item retains its link to the originating input item.
- **On Error: Continue** returns an `{ error }` item. API errors include `message`, `name`, `status`, `httpCode`, `model` and the existing compatibility keys `methode` (method) and `odoo_nicht_erreichbar` (availability failure).

### Outage Logs

The second output emits one item per event under `json.log`, independently of the result count:

```json
{
  "log": {
    "event": "unavailable",
    "level": "warn",
    "message": "Odoo is unavailable (HTTP 503) for res.partner/search_read, attempt 1; waiting for /web/health",
    "timestamp": "2026-11-21T10:00:00.000Z",
    "attempt": 1,
    "httpStatus": 503,
    "waitingSince": "2026-11-21T10:00:00.000Z",
    "workflow": "Read companies",
    "workflow_id": "example-workflow",
    "execution_id": "example-execution",
    "node": "Read Companies",
    "model": "res.partner",
    "method": "search_read",
    "odoo_url": "https://odoo.example.com"
  }
}
```

| Event | Level | Meaning |
| --- | --- | --- |
| `unavailable` | warn | Entering an outage wait. |
| `waiting` | warn | Odoo is still unavailable. |
| `recovered` | info | Health passed and the request can be retried. |
| `wait_timeout` | error | The shared wait budget expired. |
| `attempts_exhausted` | error | The send limit was reached. |
| `not_retried` | error | Delivery was unclear and retrying was disabled. |
| `still_unavailable` | error | A remembered outage prevented a new send; `attempt` is `0`. |

Events are buffered until the node finishes processing its input items. A normal successful call emits no outage events. If **On Error** is **Stop Workflow**, or the execution is cancelled, downstream nodes do not receive buffered events. Choose **Continue (using regular output)** to forward logs even when a request fails, then handle `{ error }` items on Results. Ordinary validation/API errors are on Results, not Outage Logs.

The node also writes each outage event immediately to n8n's runtime logger at its event level. Forward n8n's runtime logs through your infrastructure log collector if you need live visibility during an outage.

## Logging with the separate Loki node

Install [`@artus-engineering/n8n-nodes-loki`](https://github.com/artus-engineering/n8n-nodes-loki) and connect:

```text
Manual Trigger → Loki: Set Workflow Logging → Odoo JSON-2
                                               ├─ Results → your business workflow
                                               └─ Outage Logs → Loki: Send Log
```

On **Loki: Send Log**, select your existing **Loki API** credential and configure:

| Setting | Value |
| --- | --- |
| Log Format | `JSON` |
| JSON Input Mode | `JSON` |
| JSON | `={{ $json.log }}` |
| Labels | `level` = `={{ $json.log.level }}`, `component` = `odoo` |
| Options → Timestamp | `={{ $json.log.timestamp }}` |

The Loki node applies its upstream **Set Workflow Logging** toggle and defaults. Odoo also carries an input item's `_lokiLogging` settings onto log items, which preserves inherited settings across sub-workflows. The log payload stays under `log` so configuration and additional headers are not serialized into the log line.

Odoo does not read Loki credentials, send Loki HTTP requests or depend on the Loki package. The Loki node owns authentication, tenant headers, labels, batching and its own error handling. Its automatic labels include `job`, `workflow` and `workflow_id`; `execution_id` is structured metadata. That metadata requires a compatible Loki installation (Loki 3.0+ with TSDB schema v13).

See the [example setup instructions](examples/README.md) for the ready-to-import workflow and how to handle errors on Results.

## Migration from built-in Loki logging

This change removes **Log Outages to Loki** and the **Odoo JSON-2 Loki API** credential type from this package to comply with n8n's single-credential and package-isolation rules.

Before upgrading workflows that use built-in logging:

1. Record the old Loki connection settings and create/select a **Loki API** credential in `@artus-engineering/n8n-nodes-loki`.
2. Connect the new **Outage Logs** output to **Loki: Send Log** using the settings above. Existing Results connections stay on the first output (Results).
3. Select **On Error: Continue (using regular output)** if terminal outage events must reach Loki, and handle the Results error items explicitly.
4. Update dashboards to the English event schema under `log` (`event`, `method`, `attempt`, `waitingSince`, `httpStatus`). The old `ereignis`/`methode`/`versuch`/`wartet_seit` fields and `stufe` label are no longer generated by this package.

Logging is now delivered after node completion. For live outage messages, collect the n8n runtime logs instead. Existing Odoo credentials and the Results output format remain compatible.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| `401` / `403` | API key validity, user permissions, database name and API access for your Odoo deployment. |
| `404` | Odoo version, base URL, model and method. JSON-2 starts with Odoo 19. |
| Keeps waiting although the site loads | `/web/health` must be reachable from the n8n worker and return a successful status with `status: pass`. |
| Fails immediately after a long outage | A worker remembered the outage; its health check must pass before another JSON-2 request is sent. |
| Create/action fails after a timeout | Check Odoo for the result before retrying manually; the operation may already have committed. |
| No results | `search_read` may have returned `[]`. Use Full Response to inspect the HTTP response. |
| No Loki events during the wait | The Outage Logs output is delivered on completion. Use n8n runtime log collection for live events. |
| No Loki events after a failure | Use On Error: Continue (using regular output), connect Outage Logs, and check the Loki workflow toggle and credential. |

## Development

```bash
git clone https://github.com/artus-engineering/n8n-nodes-odoo.git
cd n8n-nodes-odoo
pnpm install --frozen-lockfile
pnpm run dev
```

`dev` starts n8n on port 5678 with this node linked. Run the full check suite before opening a PR:

```bash
pnpm run check
```

This runs Biome, strict n8n lint, TypeScript, the build, Vitest with coverage, npm package-content checks and the official n8n community package scanner. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup and [AGENTS.md](AGENTS.md) for the repository's implementation conventions.

## Releases

A [GitHub Release](https://github.com/artus-engineering/n8n-nodes-odoo/releases) with a semver tag triggers the publishing workflow. The tag without `v` becomes the package version. The workflow checks the package and publishes to npm through [Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) with provenance, then mirrors it to GitHub Packages.

Maintainers should release a tested commit from `main`. Local npm publishing is not part of this project's release process. See [docs/ci.md](docs/ci.md) for publishing, fork PR checks and verification after release.

## Contributing and support

Bug reports, documentation improvements and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) and our [Code of Conduct](CODE_OF_CONDUCT.md), then open an [issue](https://github.com/artus-engineering/n8n-nodes-odoo/issues/new/choose).

Report vulnerabilities privately using [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE). Maintained by [Artus Engineering GmbH](https://artus-engineering.de).
