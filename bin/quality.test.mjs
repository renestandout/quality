/**
 * Was `--base` in einer vollflächigen Stufe bedeutet.
 *
 * Der Anlass: ein cc-Worktree zweigt von main ab, danach landet auf main ein
 * Format-Fix. Der Zweig trägt die alte, unformatierte Fassung weiter, ohne sie
 * angefasst zu haben. `quality full` prüfte den ganzen Komponenten-Pfad und
 * machte daraus ein rotes Gate — für fremde Arbeit, die beim Merge von selbst
 * verschwindet. Gemessen am 20.09.2026 im rankscan-Worktree
 * `rankscan-filter-matrix-gegenprobe-controller-nach` an
 * `resources/js/pages/Settings/components/PlanSelector.test.tsx`.
 *
 * Geprüft wird über den echten Prozess, nicht über eine importierte Funktion:
 * die Frage ist gerade, welche Dateien am Ende beim Werkzeug ankommen, und das
 * entscheidet sich erst im Zusammenspiel von Stufe, Diff und Stack-Adapter.
 *
 * Das Formatierwerkzeug ist eine Attrappe. Sie hält fest, womit sie aufgerufen
 * wurde, und nennt jede Datei mit dem Wort UNFORMATTED unformatiert. Ob
 * prettier richtig formatiert, ist hier nicht die Frage — die Frage ist, was
 * quality ihm übergibt und wie es sein Urteil wertet.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const QUALITY = join(dirname(fileURLToPath(import.meta.url)), 'quality')

/** Attrappe statt prettier: nennt ihre Ziele und urteilt nach einem Marker. */
const FAKE_PRETTIER = `#!/usr/bin/env node
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const targets = process.argv.slice(2).filter((a) => !a.startsWith('--'))
process.stdout.write('targets: ' + targets.join(' ') + '\\n')

const walk = (dir) =>
  readdirSync(dir).flatMap((entry) => {
    if (entry === 'node_modules' || entry === '.git') return []
    const path = join(dir, entry)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })

const files = targets.flatMap((t) => (t === '.' ? walk('.').map((f) => f.replace(/^\\.\\//, '')) : [t]))
const bad = files.filter((f) => readFileSync(f, 'utf8').includes('UNFORMATTED'))
for (const f of bad) process.stdout.write('[warn] ' + f + '\\n')
process.exit(bad.length > 0 ? 1 : 0)
`

const git = (args, cwd) => execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'ignore'] })

/**
 * Baut die Lage nach: Basis-Commit mit unformatierter Altlast, davon ein Zweig
 * mit eigener Arbeit, danach der Format-Fix auf main.
 *
 * @param {object} args
 * @param {boolean} args.eigeneDateiUnformatiert  ist die Arbeit des Zweigs selbst unformatiert?
 */
function lage({ eigeneDateiUnformatiert = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'quality-base-')))
  const schreibe = (name, text) => writeFileSync(join(dir, name), text)

  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.bin', 'prettier'), FAKE_PRETTIER)
  chmodSync(join(dir, 'node_modules', '.bin', 'prettier'), 0o755)

  git(['init', '-q', '-b', 'main'], dir)
  git(['config', 'user.email', 'test@example.com'], dir)
  git(['config', 'user.name', 'Test'], dir)

  schreibe('quality.yml', 'version: 1\nlevel: standard\nbaseline: false\ncomponents:\n  - { path: ".", stack: react-ts }\n')
  schreibe('.gitignore', 'node_modules/\n')
  schreibe('legacy.ts', 'export const legacy = 1 // UNFORMATTED\n')
  schreibe('mine.ts', 'export const mine = 1\n')
  git(['add', '-A'], dir)
  git(['commit', '-qm', 'Basis mit unformatierter Altlast'], dir)

  git(['checkout', '-q', '-b', 'task'], dir)
  schreibe('mine.ts', `export const mine = 2${eigeneDateiUnformatiert ? ' // UNFORMATTED' : ''}\n`)
  git(['commit', '-qam', 'Arbeit des Zweigs'], dir)

  git(['checkout', '-q', 'main'], dir)
  schreibe('legacy.ts', 'export const legacy = 1\n')
  git(['commit', '-qam', 'Format-Fix auf main'], dir)
  git(['checkout', '-q', 'task'], dir)

  return dir
}

/** Führt quality aus und gibt Ausgabe und Exit-Code zurück, ohne zu werfen. */
function quality(dir, args) {
  try {
    const output = execFileSync(process.execPath, [QUALITY, ...args], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, NO_COLOR: '1' },
    })
    return { output, code: 0 }
  } catch (err) {
    return { output: `${err.stdout ?? ''}${err.stderr ?? ''}`, code: err.status ?? 1 }
  }
}

test('--base: eine Altlast ausserhalb des Zweigs blockiert nicht mehr', () => {
  const dir = lage()
  try {
    const { output, code } = quality(dir, ['task', '--only', 'fmt', '--base', 'main'])

    assert.equal(code, 0, `Gate müsste grün sein, war aber ${code}:\n${output}`)
    // Sichtbar bleibt die Altlast trotzdem — das ist der ganze Zweck.
    assert.match(output, /legacy\.ts/)
    assert.match(output, /Hinweis/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--base: der harte Lauf bekommt genau die Dateien des Zweigs', () => {
  const dir = lage()
  try {
    const { output } = quality(dir, ['task', '--only', 'fmt', '--base', 'main'])

    assert.match(output, /targets: mine\.ts$/m)
    // Und der weiche Lauf sieht weiterhin die ganze Fläche.
    assert.match(output, /targets: \.$/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('--base: unformatierte eigene Arbeit blockiert weiterhin', () => {
  const dir = lage({ eigeneDateiUnformatiert: true })
  try {
    const { output, code } = quality(dir, ['task', '--only', 'fmt', '--base', 'main'])

    assert.equal(code, 1, `Gate müsste rot sein, war aber ${code}:\n${output}`)
    assert.match(output, /fehlgeschlagen/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ohne --base bleibt die ganze Fläche hart', () => {
  // Ohne Basis weiss quality nicht, was der Anteil dieses Zweigs ist. Dann ist
  // alles sein Anteil — nur so bleibt eine CI ohne --base so streng wie bisher.
  const dir = lage()
  try {
    const { output, code } = quality(dir, ['task', '--only', 'fmt'])

    assert.equal(code, 1, `Gate müsste rot sein, war aber ${code}:\n${output}`)
    assert.match(output, /legacy\.ts/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
