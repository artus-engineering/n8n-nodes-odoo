# n8n-nodes-odoo

An [n8n](https://n8n.io) community node for the [Odoo JSON-2 API](https://www.odoo.com/documentation/19.0/developer/reference/external_api.html) that waits out Odoo outages instead of failing, and logs them to [Grafana Loki](https://grafana.com/oss/loki/).

## Features

- **JSON-2 calls** — `POST /json/2/<model>/<method>` with any body, e.g. `search_read`, `read`, `write`, `create`, `unlink` or model actions
- **Waits for Odoo** — on HTTP 405/503 or a refused connection the node polls `/web/health` until it reports `{"status": "pass"}` and resends the request
- **Safe retries** — after HTTP 502/504 or a timeout Odoo may already have executed the request, so it is only resent for read methods and `write` (configurable)
- **Fails fast during long outages** — after the maximum wait, later requests to the same Odoo URL fail at once until `/web/health` passes again
- **Behaves like the HTTP Request node** — one item per record, `{ data }` for scalar responses, `{ error }` items with *On Error: Continue*, so it can replace an HTTP Request node without changes downstream
- **Loki logging** — outage, waiting, recovery and give-up events with workflow, node, execution ID, model, method and HTTP status
- **Zero runtime dependencies**

## Installation

In n8n, go to **Settings → Community Nodes → Install** and enter:

```
@artus-engineering/n8n-nodes-odoo
```

## Credentials

**Odoo JSON-2 API**

| Field | Description |
| --- | --- |
| Odoo URL | Base URL of the Odoo instance, used when the node leaves its own URL empty |
| Database | Sent as `X-Odoo-Database`, used when the node leaves its own database empty |
| API Key | Odoo API key, sent as bearer token |

**Odoo JSON-2 Loki API** (only with *Log Outages to Loki*) has the same fields as the credential of [`@artus-engineering/n8n-nodes-loki`](https://github.com/artus-engineering/n8n-nodes-loki): URL, authentication (none, basic, bearer, header), tenant ID and custom headers. n8n does not let a community node use credentials of another package, hence the separate type.

## Node reference

| Parameter | Description |
| --- | --- |
| Odoo URL, Database | Override the credential, e.g. from an expression |
| Model, Method | e.g. `res.partner`, `search_read` |
| Body | JSON-2 body, e.g. `{ "domain": [], "fields": ["name"] }` |
| Retry After Unclear Failure | `Automatic` (read methods and `write`), `Always` or `Never` |
| Output | `Records` or `Full Response` (`statusCode`, `headers`, `body`) |
| Log Outages to Loki | Write events to Loki |
| Options | Max Wait (60 min), Check Interval (30 s), Max Attempts (5), Waiting Log Interval (5 min), Timeout (120 s) |

### When the node waits

| Response | Behaviour |
| --- | --- |
| 2xx | Output |
| 405, 503, connection refused, host not found | Wait for `/web/health`, then resend |
| 502, 504, timeout, connection reset | Wait and resend only if retryable, otherwise fail with a hint to check Odoo |
| anything else | Fail at once with Odoo's error message |

While waiting, the execution keeps its worker busy. Make sure `EXECUTIONS_TIMEOUT` (if set) is longer than the maximum wait.

### Loki events

Stream labels `job=n8n`, `workflow`, `workflow_id`, `stufe=odoo_verfuegbarkeit`, `level`; structured metadata `execution_id`. The JSON line carries `message`, `ereignis`, `node`, `model`, `methode`, `http_status`, `versuch`, `wartet_seit`, `odoo_url`.

| `ereignis` | `level` |
| --- | --- |
| `odoo_nicht_erreichbar` | warn |
| `odoo_wartet` | warn |
| `odoo_wieder_erreichbar` | info |
| `odoo_wartezeit_ueberschritten` | error |
| `odoo_aufgegeben` | error |
| `odoo_nicht_wiederholt` | error |

## Development

See [AGENTS.md](AGENTS.md).

```bash
pnpm install
pnpm run lint && pnpm run lint:n8n && pnpm run typecheck && pnpm run build && pnpm run test
```

## Releases

Create a GitHub Release with a semver tag (e.g. `v0.1.0`). `.github/workflows/publish.yaml` publishes to npm with provenance via Trusted Publishing.

## License

[MIT](LICENSE)
