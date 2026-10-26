import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

// Die Sandbox für den security-audit-Skill braucht nur der Audit-Host.
// Sie darf weder ins npm-Paket noch ins Composer-Archiv gelangen.

const root = new URL('..', import.meta.url)
const read = (/** @type {string} */ name) => readFileSync(new URL(name, root), 'utf8')

test('package.json: files nennt security-audit nicht', () => {
  const files = /** @type {string[]} */ (JSON.parse(read('package.json')).files)
  assert.equal(files.filter((f) => f.replace(/^\.?\//, '').startsWith('security-audit')).length, 0)
})

test('gitattributes: security-audit ist export-ignore', () => {
  assert.match(read('.gitattributes'), /^\/security-audit export-ignore$/m)
})

test('composer.json: archive.exclude enthält /security-audit', () => {
  assert.ok(JSON.parse(read('composer.json')).archive?.exclude?.includes('/security-audit'))
})

test('git archive: enthält security-audit nicht', () => {
  const cwd = fileURLToPath(root)
  const tar = execFileSync('git', ['archive', '--worktree-attributes', 'HEAD'], { cwd, maxBuffer: 64 * 1024 * 1024 })
  const list = execFileSync('tar', ['-t'], { input: tar, maxBuffer: 64 * 1024 * 1024 }).toString()
  assert.equal(list.split('\n').filter((l) => l.startsWith('security-audit/')).length, 0)
})
