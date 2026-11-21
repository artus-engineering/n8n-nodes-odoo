import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const pkg = JSON.parse(readFileSync('package.json', 'utf8'))
const [packed] = JSON.parse(
    execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
    })
)
const paths = new Set(packed.files.map(file => file.path))

for (const required of [
    'package.json',
    'README.md',
    'LICENSE',
    ...pkg.n8n.nodes,
    ...pkg.n8n.credentials,
    'dist/nodes/OdooJson2/OdooJson2.node.json',
    'dist/nodes/OdooJson2/odoo.svg',
    'dist/nodes/OdooJson2/odoo.dark.svg'
]) {
    assert(paths.has(required), `Missing package file: ${required}. Run pnpm run build first.`)
}

for (const path of paths) {
    assert(
        ['package.json', 'README.md', 'LICENSE', 'dist/package.json'].includes(path) ||
            /^dist\/(nodes|credentials)\//.test(path),
        `Unexpected package file: ${path}`
    )
    assert(
        !path.includes('OdooLokiApi') && !path.endsWith('/loki.svg') && !path.endsWith('/loki.dark.svg'),
        `Obsolete Loki artifact in package: ${path}. Rebuild before publishing.`
    )
}

const builtPackage = JSON.parse(readFileSync('dist/package.json', 'utf8'))
assert.equal(builtPackage.version, pkg.version, 'Built package version differs from package.json; rebuild it')
assert.deepEqual(builtPackage.n8n, pkg.n8n, 'Built node registrations are stale; rebuild the package')
console.log(`Package contents verified: ${paths.size} files, ${packed.unpackedSize} unpacked bytes`)
