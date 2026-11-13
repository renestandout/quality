/**
 * `gitIn` — der eine Weg, git in einem Verzeichnis aufzurufen.
 *
 * deploy-check, release und der Stop-Hook hatten je eine eigene Kopie. Die
 * Tests halten fest, worauf sich alle drei verlassen.
 */
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gitIn } from './git.mjs'

test('gitIn: läuft im angegebenen Verzeichnis und kürzt die Ausgabe', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-git-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  gitIn(['init', '--quiet', '--initial-branch=main'], dir)

  const top = gitIn(['rev-parse', '--show-toplevel'], dir)

  assert.ok(!top.endsWith('\n'))
  assert.ok(top.endsWith(join(dir).split('/').at(-1) ?? ''), top)
})

test('gitIn: wirft bei einem Fehler und trägt die Meldung von git in stderr', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-git-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.throws(
    () => gitIn(['rev-parse', 'HEAD'], dir),
    (/** @type {Error & { stderr?: string }} */ err) =>
      /not a git repository/i.test(err.stderr ?? ''),
  )
})
