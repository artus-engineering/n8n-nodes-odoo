# Example workflows

Download a JSON file and use **Import from File** in the n8n editor. Both examples are inactive, contain no credentials or credential IDs, and only read Odoo data.

## Read companies

Import [read-companies.json](read-companies.json), select an **Odoo JSON-2 API** credential on **Read Companies**, then execute the workflow. It returns up to ten company records from `res.partner`, with `id` and `name`.

## Read companies with Loki logging

Install both `@artus-engineering/n8n-nodes-odoo` and `@artus-engineering/n8n-nodes-loki`, then import [read-companies-with-loki.json](read-companies-with-loki.json).

1. Select an **Odoo JSON-2 API** credential on **Read Companies**.
2. Select your existing **Loki API** credential on **Send Outage Log**.
3. Adjust the workflow defaults on **Set Workflow Logging**. It starts enabled and adds `env=demo`; turn it off to mute the Loki sender.
4. Replace **Process Companies** with the business processing you need and **Handle Failed Request** with your error handling.
5. Execute the workflow against a test Odoo instance.

**Read Companies** uses **On Error: Continue (using regular output)** so its buffered events reach the second output even if Odoo remains unavailable. Its first output goes through **Request Failed?**, which separates error items from successful records. The placeholder failure branch deliberately does not throw: stopping that branch can prevent the separate logging branch from executing.

**Send Outage Log** also uses Continue so a logging failure does not turn an Odoo result into a failed execution. Add handling for its error output if logging delivery is mandatory for your workflow.

The Loki sender serializes only `$json.log`, uses the original event timestamp, and adds `level` and `component=odoo` labels. Workflow defaults and credentials remain in the Loki nodes. The Loki node adds workflow labels and execution metadata itself.

A healthy call produces no outage logs. Use a controlled outage in a test environment to exercise recovery; events arrive after Odoo finishes waiting, not during the outage. Cancelling or stopping the execution prevents downstream delivery. For live diagnostics, collect n8n's runtime logs.
