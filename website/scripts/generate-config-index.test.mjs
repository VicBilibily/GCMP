import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, copyFile, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

const model = { id: 'extra', name: 'Extra', maxInputTokens: 1000, maxOutputTokens: 100 }

for (const [label, models, success] of [
    ['valid', [model], true],
    ['empty', [], true],
    ['duplicate extra', [model, model], false],
    ['builtin conflict', [{ ...model, id: 'builtin' }], false],
    ['empty id', [{ ...model, id: '' }], false],
    ['blank name', [{ ...model, name: '  ' }], false],
    ['invalid tokens', [{ ...model, maxInputTokens: '1000' }], false],
    ['zero tokens', [{ ...model, maxOutputTokens: 0 }], false],
    ['excessive tokens', [{ ...model, maxInputTokens: 10000001 }], false],
    ['forbidden field', [{ ...model, baseUrl: 'https://example.com' }], false],
    ['proto field', [{ ...model, ['__proto__']: {} }], false],
    ['constructor field', [{ ...model, constructor: {} }], false],
    ['prototype field', [{ ...model, prototype: {} }], false],
    ['null model', [null], false]
]) {
    test(label, async () => {
        const root = await mkdtemp(path.join(tmpdir(), 'gcmp-extra-'))
        try {
            for (const dir of ['website/scripts', 'website/remote-extra', 'src/providers/config', 'src/utils/metadata']) {
                await mkdir(path.join(root, dir), { recursive: true })
            }
            await copyFile(new URL('./generate-config-index.mjs', import.meta.url), path.join(root, 'website/scripts/generate-config-index.mjs'))
            await writeFile(path.join(root, 'package.json'), JSON.stringify({ version: '1.0.0' }))
            await writeFile(path.join(root, 'src/utils/metadata/gcmp-metadata.json'), '{}')
            await writeFile(path.join(root, 'src/providers/config/demo.json'), JSON.stringify({ models: [{ ...model, id: 'builtin' }] }))
            await writeFile(path.join(root, 'website/remote-extra/demo.json'), JSON.stringify({ models }))
            const result = spawnSync(process.execPath, [path.join(root, 'website/scripts/generate-config-index.mjs')], { encoding: 'utf8' })
            assert.equal(result.status === 0, success, result.stderr)
            if (success) {
                const output = JSON.parse(await readFile(path.join(root, 'website/public/configs/demo.json'), 'utf8'))
                assert.equal(output.models.length, models.length + 1)
            }
        } finally {
            await rm(root, { recursive: true, force: true })
        }
    })
}
