import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'

const PKG_ROOT = join(import.meta.dirname, '..')

test('Die Basiskonfiguration legt keine Dateien im Projekt an', () => {
  // Beim adboard-Rollout aufgefallen: ein projektlokaler PHPStan-Cache landet
  // als untracked im Repository, und der Tamper-Check hält dem Entwickler dann
  // Suppressions aus fremdem Cache-Inhalt vor. Werkzeuge des Frameworks
  // schreiben nur ins System-Temp — im Projekt entsteht nichts, was jemand
  // hinterher in .gitignore nachtragen müsste.
  const neon = readFileSync(join(PKG_ROOT, 'configs', 'phpstan', 'base.neon'), 'utf8')
  const wirksam = neon
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n')
  assert.doesNotMatch(wirksam, /tmpDir/, 'base.neon setzt tmpDir und legt damit ein Verzeichnis im Projekt an')
  assert.doesNotMatch(wirksam, /%currentWorkingDirectory%/)
})

test('Die Basiskonfiguration legt das Level nicht fest', () => {
  // Das Level kommt aus quality.yml und wird als --level übergeben. Stünde es
  // zusätzlich hier, gäbe es zwei Quellen der Wahrheit.
  const neon = readFileSync(join(PKG_ROOT, 'configs', 'phpstan', 'base.neon'), 'utf8')
  const wirksam = neon.split('\n').filter((line) => !line.trim().startsWith('#'))
  assert.ok(!wirksam.some((line) => /^\s*level:/.test(line)))
})
