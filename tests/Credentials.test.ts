import { describe, expect, it } from 'vitest'
import { OdooJson2Api } from '../credentials/OdooJson2Api.credentials'
import { OdooLokiApi } from '../credentials/OdooLokiApi.credentials'
import pkg from '../package.json'

describe('OdooJson2Api credential', () => {
    const credential = new OdooJson2Api()

    it('is registered in package.json', () => {
        expect(pkg.n8n.credentials).toContain('dist/credentials/OdooJson2Api.credentials.js')
        expect(credential.name).toBe('odooJson2Api')
    })

    it('sends the API key as bearer token', () => {
        expect(credential.authenticate).toEqual({
            type: 'generic',
            properties: { headers: { Authorization: '=Bearer {{$credentials.apiKey}}' } }
        })
    })

    it('tests against a JSON-2 call with the database header', () => {
        expect(credential.test.request).toMatchObject({
            url: '/json/2/res.users/context_get',
            method: 'POST',
            headers: { 'X-Odoo-Database': '={{ $credentials.database }}' }
        })
    })
})

describe('OdooLokiApi credential', () => {
    const credential = new OdooLokiApi()

    it('is registered in package.json', () => {
        expect(pkg.n8n.credentials).toContain('dist/credentials/OdooLokiApi.credentials.js')
        expect(credential.name).toBe('odooLokiApi')
    })

    it.each([
        [{ authentication: 'none' }, {}],
        [{ authentication: 'bearerToken', token: 't' }, { Authorization: 'Bearer t' }],
        [{ authentication: 'headerAuth', headerName: 'X-Key', headerSecret: 's' }, { 'X-Key': 's' }],
        [
            { authentication: 'none', tenantId: 'tenant', customHeaders: { header: [{ name: 'X-A', value: '1' }] } },
            { 'X-Scope-OrgID': 'tenant', 'X-A': '1' }
        ]
    ])('sets headers for %o', async (credentials, headers) => {
        const options = await credential.authenticate(credentials, { url: 'https://loki.test', headers: {} })
        expect(options.headers).toEqual(headers)
    })

    it('uses basic auth', async () => {
        const options = await credential.authenticate(
            { authentication: 'basicAuth', username: 'u', password: 'p' },
            { url: 'https://loki.test' }
        )
        expect(options.auth).toEqual({ username: 'u', password: 'p' })
    })
})
