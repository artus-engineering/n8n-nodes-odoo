import type { INodeProperties } from 'n8n-workflow'

export const odooJson2Properties: INodeProperties[] = [
    {
        displayName: 'Odoo URL',
        name: 'odooUrl',
        type: 'string',
        default: '',
        placeholder: 'https://odoo.example.com',
        description: 'Base URL of the Odoo instance. Leave empty to use the URL from the credential.'
    },
    {
        displayName: 'Database',
        name: 'database',
        type: 'string',
        default: '',
        description: 'Database sent as the X-Odoo-Database header. Leave empty to use the database from the credential.'
    },
    {
        displayName: 'Model',
        name: 'model',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'res.partner',
        description: 'Technical name of the Odoo model'
    },
    {
        displayName: 'Method',
        name: 'method',
        type: 'string',
        default: '',
        required: true,
        placeholder: 'search_read',
        description: 'Method of the model, called through the JSON-2 endpoint of Odoo'
    },
    {
        displayName: 'Body',
        name: 'body',
        type: 'json',
        default: '{}',
        description:
            'JSON-2 request body, for example a domain with fields for search_read or record IDs with values for write'
    },
    {
        displayName: 'Retry After Unclear Failure',
        name: 'retryMode',
        type: 'options',
        default: 'automatic',
        options: [
            {
                name: 'Automatic',
                value: 'automatic',
                description: 'Resend read methods and write, never create, unlink or other actions'
            },
            {
                name: 'Always',
                value: 'always',
                description: 'Resend after HTTP 502/504 or a timeout'
            },
            {
                name: 'Never',
                value: 'never',
                description: 'Fail after HTTP 502/504 or a timeout'
            }
        ],
        description:
            'After HTTP 502/504 or a timeout Odoo may already have executed the request. HTTP 405/503 and refused connections are always waited out and resent.'
    },
    {
        displayName: 'Output',
        name: 'output',
        type: 'options',
        default: 'records',
        options: [
            {
                name: 'Records',
                value: 'records',
                description: 'One item per array entry, { data } for scalar responses'
            },
            {
                name: 'Full Response',
                value: 'fullResponse',
                description: 'One item with statusCode, headers and body'
            }
        ]
    },
    {
        displayName: 'Log Outages to Loki',
        name: 'lokiLogging',
        type: 'boolean',
        default: false,
        description: 'Whether to write outage, waiting and recovery events to Loki'
    },
    {
        displayName: 'Options',
        name: 'options',
        type: 'collection',
        placeholder: 'Add Option',
        default: {},
        options: [
            {
                displayName: 'Check Interval (Seconds)',
                name: 'checkIntervalSeconds',
                type: 'number',
                typeOptions: { minValue: 1 },
                default: 30,
                description: 'How often /web/health is polled while Odoo is unavailable'
            },
            {
                displayName: 'Max Attempts',
                name: 'maxAttempts',
                type: 'number',
                typeOptions: { minValue: 1 },
                default: 5,
                description: 'How often the same request is sent before giving up'
            },
            {
                displayName: 'Max Wait (Minutes)',
                name: 'maxWaitMinutes',
                type: 'number',
                typeOptions: { minValue: 1 },
                default: 60,
                description:
                    'How long to wait for Odoo before failing. Later requests to the same Odoo URL then fail at once while it stays down.'
            },
            {
                displayName: 'Timeout (Seconds)',
                name: 'timeoutSeconds',
                type: 'number',
                typeOptions: { minValue: 1 },
                default: 120,
                description: 'Timeout of a single request to Odoo'
            },
            {
                displayName: 'Waiting Log Interval (Minutes)',
                name: 'waitingLogMinutes',
                type: 'number',
                typeOptions: { minValue: 1 },
                default: 5,
                description: 'How often a "still waiting" event is written to Loki'
            }
        ]
    }
]
