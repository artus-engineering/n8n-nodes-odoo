import type { IAuthenticateGeneric, ICredentialTestRequest, ICredentialType, INodeProperties } from 'n8n-workflow'

export class OdooJson2Api implements ICredentialType {
    name = 'odooJson2Api'

    displayName = 'Odoo JSON-2 API'

    icon = {
        light: 'file:../nodes/OdooJson2/odoo.svg',
        dark: 'file:../nodes/OdooJson2/odoo.dark.svg'
    } as const

    documentationUrl = 'https://www.odoo.com/documentation/19.0/developer/reference/external_api.html'

    properties: INodeProperties[] = [
        {
            displayName: 'Odoo URL',
            name: 'url',
            type: 'string',
            default: '',
            placeholder: 'https://odoo.example.com',
            description:
                'Base URL of the Odoo instance. Used for the credential test and whenever the node leaves its own Odoo URL empty.',
            required: true
        },
        {
            displayName: 'Database',
            name: 'database',
            type: 'string',
            default: '',
            description:
                'Database sent as the X-Odoo-Database header. Used for the credential test and whenever the node leaves its own database empty.'
        },
        {
            displayName: 'API Key',
            name: 'apiKey',
            type: 'string',
            typeOptions: { password: true },
            default: '',
            required: true
        }
    ]

    authenticate: IAuthenticateGeneric = {
        type: 'generic',
        properties: {
            headers: {
                Authorization: '=Bearer {{$credentials.apiKey}}'
            }
        }
    }

    test: ICredentialTestRequest = {
        request: {
            baseURL: String.raw`={{ $credentials.url.trim().replace(/\/+$/, "") }}`,
            url: '/json/2/res.users/context_get',
            method: 'POST',
            headers: {
                'X-Odoo-Database': '={{ $credentials.database }}'
            },
            body: {}
        }
    }
}
