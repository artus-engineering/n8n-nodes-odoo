import { describe, expect, it } from 'vitest'
import { OdooJson2Api } from '../credentials/OdooJson2Api.credentials'
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
