/**
 * Wann der Stop-Hook prüft und wann er sich heraushält.
 *
 * Der Anlass: Am 12.10.2026 blockierte der Hook die Koordinations-Session von
 * rankscan dreimal. Diese Session ändert nie Code, sie integriert nur Branches
 * über `cc --integrieren`. Der Befund stammte aus einem fremden Commit und war
 * nur im Prüfumfang, weil gerade ein ungecommitteter Merge lag. Dazu
 * formatierte der Hook schreibend — mitten im Gate der Integration.
 *
 * Geprüft wird über den echten Prozess: der Hook liest JSON von stdin und
 * antwortet über Exit-Code und stderr. Das Formatierwerkzeug ist eine
 * Attrappe, die jede Datei mit dem Wort UNFORMATTED unformatiert nennt und
 * mit --write umschreibt.
 */
import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'stop-gate.mjs')

const FAKE_PRETTIER = `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs'

const files = process.argv.slice(2).filter((a) => !a.startsWith('--'))
const bad = files.filter((f) => readFileSync(f, 'utf8').includes('UNFORMATTED'))
if (process.argv.includes('--write')) {
  for (const f of bad) writeFileSync(f, readFileSync(f, 'utf8').replace('UNFORMATTED', 'formatted'))
  process.exit(0)
}
for (const f of bad) process.stdout.write('[warn] ' + f + '\\n')
process.exit(bad.length > 0 ? 1 : 0)
`

const git = (/** @type {string[]} */ args, /** @type {string} */ cwd) =>
  execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })

/** Ein Projekt mit Gate und einer uncommitteten, unformatierten Datei. */
function projekt() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quality-stop-')))
  const schreibe = (/** @type {string} */ name, /** @type {string} */ text) =>
    writeFileSync(join(dir, name), text)

  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.bin', 'prettier'), FAKE_PRETTIER)
  chmodSync(join(dir, 'node_modules', '.bin', 'prettier'), 0o755)

  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)
  schreibe(
    'quality.yml',
    'version: 1\nlevel: standard\nbaseline: false\ncomponents:\n  - { path: ".", stack: react-ts }\n',
  )
  schreibe('.gitignore', 'node_modules/\n')
  schreibe('a.ts', 'export const a = 1\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'Basis'], dir)

  schreibe('a.ts', 'export const a = 2 // UNFORMATTED\n')
  return dir
}

/**
 * Lässt im Projekt einen Merge offen, wie `cc --integrieren` ihn vor dem Gate hinterlässt.
 *
 * @param {string} dir
 */
function offenerMerge(dir) {
  git(['checkout', '-q', '-b', 'task'], dir)
  writeFileSync(join(dir, 'b.ts'), 'export const b = 1 // UNFORMATTED\n')
  git(['add', 'b.ts'], dir)
  git(['commit', '-qm', 'Arbeit eines Workers'], dir)
  git(['checkout', '-q', 'main'], dir)
  git(['merge', '-q', '--no-ff', '--no-commit', 'task'], dir)
}

let sitzung = 0

/** @param {string} dir */
function stopHook(dir) {
  const input = JSON.stringify({ cwd: dir, session_id: `test-${process.pid}-${++sitzung}` })
  const r = spawnSync(process.execPath, [HOOK], {
    input,
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  })
  return { code: r.status, stderr: r.stderr }
}

test('ohne besondere Lage bleibt eine unformatierte Datei rot', () => {
  const dir = projekt()
  try {
    const { code, stderr } = stopHook(dir)

    assert.equal(code, 2, stderr)
    assert.match(stderr, /a\.ts/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('der Hook formatiert nie schreibend', () => {
  const dir = projekt()
  try {
    stopHook(dir)

    assert.match(readFileSync(join(dir, 'a.ts'), 'utf8'), /UNFORMATTED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('die Meldung nennt quality fix als Weg zur Formatierung', () => {
  const dir = projekt()
  try {
    const { stderr } = stopHook(dir)

    assert.match(stderr, /quality fix/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('während eines offenen Merges hält sich der Hook heraus', () => {
  const dir = projekt()
  try {
    offenerMerge(dir)
    const { code, stderr } = stopHook(dir)

    assert.equal(code, 0, stderr)
    assert.match(readFileSync(join(dir, 'b.ts'), 'utf8'), /UNFORMATTED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('in einer Koordinations-Session hält sich der Hook heraus', () => {
  const dir = projekt()
  try {
    writeFileSync(
      join(dir, 'WORKER.md'),
      '# Koordinations-Instruktionen\n\nDu koordinierst das Projekt.\n',
    )
    const { code, stderr } = stopHook(dir)

    assert.equal(code, 0, stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('in einer Worker-Session prüft der Hook weiterhin', () => {
  const dir = projekt()
  try {
    writeFileSync(
      join(dir, 'WORKER.md'),
      '# Worker-Instruktionen\n\nDu bist ein fokussierter Worker.\n',
    )
    const { code, stderr } = stopHook(dir)

    assert.equal(code, 2, stderr)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
