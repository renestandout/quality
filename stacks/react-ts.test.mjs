import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import reactTs from './react-ts.mjs'

/** @import { StackContext } from '../lib/types.mjs' */

/**
 * Ein git-Repo mit lokalem prettier-Platzhalter. findBinary prüft nur, ob die
 * Datei existiert; ausgeführt wird sie in diesen Tests nie.
 *
 * @returns {string}
 */
function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'quality-react-ts-'))
  execFileSync('git', ['init', '-q', dir])
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.bin', 'prettier'), '')
  writeFileSync(join(dir, '.gitignore'), 'node_modules\n')
  writeFileSync(join(dir, 'app.ts'), 'export {}\n')
  return dir
}

/**
 * @param {string} dir
 * @param {Partial<StackContext>} [extra]
 * @returns {StackContext}
 */
function context(dir, extra = {}) {
  return /** @type {StackContext} */ ({
    dir,
    root: dir,
    component: { path: '.', stack: 'react-ts' },
    config: {},
    files: null,
    check: true,
    full: true,
    ...extra,
  })
}

/**
 * Füllt einen Ordner mit so vielen Dateien, dass die Ausgabe von git ls-files
 * über die Standardgrenze von 1 MB steigt: 5000 Namen à 240 Zeichen.
 *
 * @param {string} folder
 * @param {string} ext
 */
function fillFolder(folder, ext) {
  mkdirSync(folder, { recursive: true })
  for (let i = 0; i < 5000; i++) {
    writeFileSync(join(folder, `${String(i).padStart(5, '0')}${'x'.repeat(235)}${ext}`), '')
  }
}

/**
 * Legt ein Skript "git" in einen eigenen Ordner und stellt den Ordner im PATH
 * nach vorn. Das Skript ersetzt git für diesen Test.
 *
 * @param {import('node:test').TestContext} t
 * @param {string} script
 */
function fakeGit(t, script) {
  const bin = mkdtempSync(join(tmpdir(), 'quality-fake-git-'))
  const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  writeFileSync(join(bin, 'git'), `#!/bin/sh\nREAL_GIT=${real}\n${script}\n`)
  chmodSync(join(bin, 'git'), 0o755)
  const path = process.env.PATH
  process.env.PATH = `${bin}:${path}`
  t.after(() => {
    process.env.PATH = path
    rmSync(bin, { recursive: true, force: true })
  })
}

/**
 * @param {StackContext} ctx
 * @returns {string[]}
 */
function fmtArgs(ctx) {
  const step = reactTs.fmt?.(ctx)
  assert.ok(step && 'args' in step && step.args, 'fmt liefert einen ausführbaren Schritt')
  return step.args
}

test('fmt: eine Datei aus info/exclude fällt aus der Prüfung der ganzen Fläche', (t) => {
  // Das Board legt WORKER.md in jedem Worktree an und schliesst sie nur über
  // info/exclude aus. prettier liest diese Datei nicht.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'WORKER.md\n')
  writeFileSync(join(dir, 'WORKER.md'), '# Auftrag\n')

  assert.deepEqual(fmtArgs(context(dir)), ['--check', '--ignore-unknown', '.', '!WORKER.md'])
})

test('fmt: im verknüpften Worktree gilt info/exclude des gemeinsamen git-Verzeichnisses', (t) => {
  const main = repo()
  const worktree = `${main}-wt`
  t.after(() => {
    rmSync(main, { recursive: true, force: true })
    rmSync(worktree, { recursive: true, force: true })
  })
  execFileSync('git', ['-C', main, 'add', '.gitignore', 'app.ts'])
  execFileSync('git', [
    '-C',
    main,
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@t',
    'commit',
    '-qm',
    'init',
  ])
  execFileSync('git', ['-C', main, 'worktree', 'add', '-q', worktree])
  appendFileSync(join(main, '.git', 'info', 'exclude'), 'WORKER.md\n')
  writeFileSync(join(worktree, 'WORKER.md'), '# Auftrag\n')
  mkdirSync(join(worktree, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(worktree, 'node_modules', '.bin', 'prettier'), '')

  assert.deepEqual(fmtArgs(context(worktree)), ['--check', '--ignore-unknown', '.', '!WORKER.md'])
})

test('fmt: Einzeldateien aus info/exclude fallen aus der Dateiliste', (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'WORKER.md\n')
  writeFileSync(join(dir, 'WORKER.md'), '# Auftrag\n')

  assert.deepEqual(fmtArgs(context(dir, { files: ['app.ts', 'WORKER.md'] })), [
    '--check',
    '--ignore-unknown',
    'app.ts',
  ])
})

test('fmt: bleibt nach dem Filtern keine Datei übrig, entfällt der Schritt', (t) => {
  // Ein Edit an WORKER.md erreicht fmt, denn .md gehört zu den JS-Dateien.
  // prettier ohne Datei-Argument prüft nichts; ein "bestanden" wäre falsch.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'WORKER.md\n')
  writeFileSync(join(dir, 'WORKER.md'), '# Auftrag\n')

  const step = reactTs.fmt?.(context(dir, { files: ['WORKER.md'] }))
  assert.ok(step && 'skip' in step && step.skip, 'fmt meldet den Schritt als entfallen')
})

test('fmt: Glob-Zeichen im Dateinamen werden für die Negation maskiert', (t) => {
  // prettier liest jedes Argument als Glob. Unmaskiert träfe "!notiz[1].md"
  // die Datei "notiz1.md" und liesse "notiz[1].md" in der Prüfung.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'notiz*\n')
  writeFileSync(join(dir, 'notiz[1].md'), '# Notiz\n')

  assert.deepEqual(fmtArgs(context(dir)), ['--check', '--ignore-unknown', '.', '!notiz\\[1\\].md'])
})

test('fmt: ausserhalb eines git-Repos bleiben die Argumente unverändert', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-react-ts-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'node_modules', '.bin'), { recursive: true })
  writeFileSync(join(dir, 'node_modules', '.bin', 'prettier'), '')

  assert.deepEqual(fmtArgs(context(dir)), ['--check', '--ignore-unknown', '.'])
})

test('fmt: ein grosser Ordner aus info/exclude erscheint als ein Muster', (t) => {
  // In resplan schliesst info/exclude /node_modules aus. git listete jede
  // Datei einzeln, über 1 MB Ausgabe. execFileSync brach mit ENOBUFS ab, und
  // WORKER.md landete still wieder in der Prüfung. Je Datei ein Argument
  // sprengte zudem ARG_MAX.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '/cache\nWORKER.md\n')
  writeFileSync(join(dir, 'WORKER.md'), '# Auftrag\n')
  fillFolder(join(dir, 'cache'), '.ts')

  assert.deepEqual(fmtArgs(context(dir)), [
    '--check',
    '--ignore-unknown',
    '.',
    '!WORKER.md',
    '!cache/**',
  ])
})

test('fmt: Einzeldateien in einem Ordner aus info/exclude fallen aus der Dateiliste', (t) => {
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '/cache\n')
  mkdirSync(join(dir, 'cache'))
  writeFileSync(join(dir, 'cache', 'x.ts'), '')

  assert.deepEqual(fmtArgs(context(dir, { files: ['app.ts', 'cache/x.ts'] })), [
    '--check',
    '--ignore-unknown',
    'app.ts',
  ])
})

test('fmt: scheitert der git-Abgleich, meldet der Schritt einen Hinweis', (t) => {
  // Ein stiller Rückfall auf eine leere Liste nimmt die ausgeschlossenen
  // Dateien wieder in die Prüfung. Der rote Lauf braucht dann eine Erklärung.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // git lehnt ein Verzeichnis als exclude-Datei ab.
  rmSync(join(dir, '.git', 'info', 'exclude'))
  mkdirSync(join(dir, '.git', 'info', 'exclude'))

  const step = reactTs.fmt?.(context(dir))
  assert.ok(
    step && 'note' in step && step.note?.includes('info/exclude'),
    'fmt meldet einen Hinweis',
  )
  assert.deepEqual(step.args, ['--check', '--ignore-unknown', '.'])
})

test('fmt: ein Ordner voller Dateien aus einem Dateimuster erscheint als ein Muster', (t) => {
  // Trifft ein Dateimuster jede Datei eines ungetrackten Ordners, listet git
  // den Ordner und dazu jede Datei einzeln. Die Ausgabe übersteigt 1 MB, und
  // die Einzeldateien sind neben "!logs/**" überflüssig.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  appendFileSync(join(dir, '.git', 'info', 'exclude'), '*.log\n')
  fillFolder(join(dir, 'logs'), '.log')

  assert.deepEqual(fmtArgs(context(dir)), ['--check', '--ignore-unknown', '.', '!logs/**'])
})

test('fmt: scheitert git schon beim Finden des git-Verzeichnisses, meldet der Schritt einen Hinweis', (t) => {
  // Ein git vor 2.31 kennt --path-format nicht. Still blieb das nur richtig,
  // solange das Verzeichnis kein Repo ist.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  fakeGit(t, "echo 'error: unknown option' >&2; exit 129")

  const step = reactTs.fmt?.(context(dir))
  assert.ok(
    step && 'note' in step && step.note?.includes('unknown option'),
    'fmt meldet einen Hinweis',
  )
})

test('fmt: der Hinweis übernimmt nur die erste Zeile der git-Meldung', (t) => {
  // Die Zusammenfassung zeigt je Schritt eine Zeile.
  const dir = repo()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  fakeGit(
    t,
    'if [ "$1" = rev-parse ]; then exec "$REAL_GIT" "$@"; fi\n' +
      "printf 'fatal: eins\\nhint: zwei\\n' >&2; exit 128",
  )

  const step = reactTs.fmt?.(context(dir))
  assert.ok(step && 'note' in step && step.note, 'fmt meldet einen Hinweis')
  assert.equal(step.note, '.git/info/exclude nicht ausgewertet (fatal: eins)')
})

/**
 * Ein Projekt mit package.json und Abhängigkeiten, aber ohne node_modules —
 * so wie ein Worktree nach "worktree-setup.sh --no-node".
 *
 * @param {Record<string, unknown>} [pkg] Felder, die das package.json ergänzen
 * @returns {string}
 */
function uninstalled(pkg = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-react-ts-no-modules-'))
  const manifest = {
    name: 'app',
    private: true,
    scripts: { lint: 'eslint src', test: 'vitest', build: 'vite build' },
    devDependencies: { eslint: '^9.0.0', typescript: '^5.0.0', vitest: '^3.0.0' },
    ...pkg,
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  return dir
}

/**
 * Führt einen Schritt aus und gibt Exit-Code und Fehlerausgabe zurück.
 *
 * @param {import('../lib/types.mjs').Step | undefined} step
 * @returns {{ code: number | null, stderr: string }}
 */
function runStep(step) {
  assert.ok(step && !step.skip && step.cmd, 'der Schritt ist ausführbar, nicht übersprungen')
  const run = spawnSync(step.cmd, step.args ?? [], { cwd: step.cwd, encoding: 'utf8' })
  return { code: run.status, stderr: run.stderr }
}

for (const verb of /** @type {const} */ (['fmt', 'lint', 'types', 'test', 'build'])) {
  test(`${verb}: ohne node_modules scheitert der Schritt mit einem Hinweis auf npm ci`, (t) => {
    // Über ein npm-Skript endete der Schritt mit exit 127 und
    // "sh: eslint: command not found". prettier und tsc fielen still weg.
    const dir = uninstalled()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const { code, stderr } = runStep(reactTs[verb]?.(context(dir)))
    assert.equal(code, 1)
    assert.match(stderr, /node_modules fehlt/)
    assert.match(stderr, /npm ci/)
  })
}

test('lint: ohne node_modules nennt der Hinweis den Paketmanager des Projekts', (t) => {
  const dir = uninstalled({ packageManager: 'pnpm@9.12.0' })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const { stderr } = runStep(reactTs.lint?.(context(dir)))
  assert.match(stderr, /pnpm install/)
})

test('lint: node_modules in der Repo-Wurzel genügt einer Unterkomponente', (t) => {
  // In einem Monorepo mit Workspaces liegt node_modules oft nur in der Wurzel.
  const root = uninstalled()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'node_modules', 'eslint'), { recursive: true })
  const dir = join(root, 'web')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { lint: 'eslint src' }, devDependencies: { eslint: '^9.0.0' } }),
  )

  const step = reactTs.lint?.(context(dir, { root }))
  assert.ok(step && step.cmd === 'npm', 'das lint-Skript läuft wie bisher')
})

test('types: mit node_modules, aber ohne typescript, entfällt tsc weiterhin', (t) => {
  // Fehlt nur ein Werkzeug, nutzt das Projekt es nicht. Das bleibt ein Skip.
  const dir = uninstalled()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'node_modules', 'eslint'), { recursive: true })

  assert.ok(reactTs.types?.(context(dir))?.skip)
})

test('types: ein package.json ohne Abhängigkeiten braucht kein node_modules', (t) => {
  const dir = uninstalled({ devDependencies: undefined })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.ok(reactTs.types?.(context(dir))?.skip)
})

test('test: ein eigener Testbefehl läuft auch ohne node_modules unverändert', (t) => {
  // Der Befehl aus quality.yml gehört dem Projekt; er braucht vielleicht gar keine Pakete.
  const dir = uninstalled()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const component = /** @type {StackContext['component']} */ ({
    path: '.',
    stack: 'react-ts',
    testCommand: 'node --test',
  })
  const step = reactTs.test?.(context(dir, { component }))
  assert.ok(step && step.cmd === 'node', 'der eigene Testbefehl bleibt')
})

test('lint: ohne Lockfile nennt der Hinweis npm install statt npm ci', (t) => {
  // npm ci bricht ohne package-lock.json ab. Der Hinweis selbst schlüge fehl.
  const dir = uninstalled()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  rmSync(join(dir, 'package-lock.json'))

  const { stderr } = runStep(reactTs.lint?.(context(dir)))
  assert.match(stderr, /npm install/)
  assert.doesNotMatch(stderr, /npm ci/)
})

test('lint: node_modules der Wurzel ohne die Pakete der Komponente zählt nicht', (t) => {
  // Die Wurzel hat nur ihre eigenen Werkzeuge installiert, etwa husky.
  // Das lint-Skript der Komponente endete sonst wieder mit exit 127.
  const root = uninstalled()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'node_modules', 'husky'), { recursive: true })
  const dir = join(root, 'web')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ scripts: { lint: 'oxlint src' }, devDependencies: { oxlint: '^1.0.0' } }),
  )

  const { code, stderr } = runStep(reactTs.lint?.(context(dir, { root })))
  assert.equal(code, 1)
  assert.match(stderr, /node_modules fehlt/)
})

test("lint: ein Projekt mit Yarn Plug'n'Play gilt ohne node_modules als installiert", (t) => {
  // Mit nodeLinker: pnp legt yarn nie node_modules an, sondern .pnp.cjs.
  const dir = uninstalled({ packageManager: 'yarn@4.5.0' })
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  writeFileSync(join(dir, '.pnp.cjs'), '')

  const step = reactTs.lint?.(context(dir))
  assert.ok(step && step.cmd !== process.execPath, 'das lint-Skript läuft wie bisher')
})

/* ── node_modules aus dem ddev-Container ──────────────────────────────── */

/*
 * In rankscan installiert worktree-setup.sh node_modules im ddev-Container.
 * Dort liegen nur die Linux-Bindings von rolldown, Tailwind und lightningcss.
 * Vitest und der vite-Build scheiterten auf dem Mac mit "Cannot find native
 * binding". Die Tests nehmen als fremde Plattform immer eine andere als die
 * des Hosts, damit sie auf macOS und im Linux-CI dasselbe prüfen.
 */

/** Eine Plattform, die nicht die des Hosts ist. */
const FOREIGN = process.platform === 'linux' ? 'darwin' : 'linux'

/**
 * Ein installiertes JS-Projekt mit ddev. node_modules/.package-lock.json
 * nennt ein natives Paket für die gewünschte Plattform, so wie npm die Datei
 * nach der Installation schreibt.
 *
 * @param {{ platform: string, scripts?: Record<string, string> }} options
 * @returns {string}
 */
function ddevProject({ platform, scripts = { build: 'vite build' } }) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-react-ts-ddev-'))
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: 'app', scripts, devDependencies: { vitest: '^4.0.0' } }),
  )
  writeFileSync(join(dir, 'package-lock.json'), '{}')
  const bin = join(dir, 'node_modules', '.bin')
  mkdirSync(bin, { recursive: true })
  mkdirSync(join(dir, 'node_modules', 'vitest'))
  for (const tool of ['prettier', 'tsc', 'vitest', 'oxlint']) writeFileSync(join(bin, tool), '')
  const binding = `node_modules/@rolldown/binding-${platform}-arm64`
  writeFileSync(
    join(dir, 'node_modules', '.package-lock.json'),
    JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/vitest': { version: '4.1.12' },
        [binding]: { version: '1.0.0', os: [platform], cpu: ['arm64'], optional: true },
      },
    }),
  )
  mkdirSync(join(dir, '.ddev'))
  writeFileSync(join(dir, '.ddev', 'config.yaml'), 'name: demo\n')
  return dir
}

/**
 * Ersetzt den PATH durch einen Ordner mit einem falschen "ddev". Das Skript
 * schreibt jeden Aufruf in ein Protokoll und meldet den gewünschten Status
 * im Format von "ddev describe -j".
 *
 * @param {import('node:test').TestContext} t
 * @param {string} status
 * @returns {{ calls: () => string[] }}
 */
function fakeDdev(t, status) {
  const bin = mkdtempSync(join(tmpdir(), 'quality-fake-ddev-'))
  const log = join(bin, 'calls.log')
  writeFileSync(
    join(bin, 'ddev'),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  describe) printf '{"level":"info","msg":"","raw":{"status":"${status}"}}\\n' ;;
esac
`,
  )
  chmodSync(join(bin, 'ddev'), 0o755)
  const path = process.env.PATH
  process.env.PATH = bin
  t.after(() => {
    process.env.PATH = path
    rmSync(bin, { recursive: true, force: true })
  })
  return {
    calls: () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : []),
  }
}

/** Der Anfang jedes Aufrufs im Container. */
const IN_CONTAINER = ['exec', '--raw', '--dir', '/var/www/html', '--']

test('vitest: node_modules aus dem Container und ddev läuft — vitest läuft im Container', (t) => {
  fakeDdev(t, 'running')
  const dir = ddevProject({ platform: FOREIGN })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const step = reactTs.test?.(context(dir))
  assert.equal(step?.cmd, 'ddev')
  assert.deepEqual(step?.args, [...IN_CONTAINER, 'node_modules/.bin/vitest', 'run'])
})

test('vitest: node_modules für den Host — vitest läuft auf dem Host, ddev bleibt unbefragt', (t) => {
  // So läuft CI und jedes Projekt, das auf dem Host installiert.
  const host = fakeDdev(t, 'running')
  const dir = ddevProject({ platform: process.platform })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const step = reactTs.test?.(context(dir))
  assert.equal(step?.cmd, join(dir, 'node_modules', '.bin', 'vitest'))
  assert.deepEqual(host.calls(), [])
})

test('vitest: node_modules aus dem Container, ddev gestoppt — der Schritt nennt ddev start', (t) => {
  fakeDdev(t, 'stopped')
  const dir = ddevProject({ platform: FOREIGN })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const { code, stderr } = runStep(reactTs.test?.(context(dir)))
  assert.equal(code, 1)
  assert.match(stderr, new RegExp(`node_modules stammt von ${FOREIGN}`))
  assert.match(stderr, /ddev start/)
})

test('build: das npm-Skript läuft im Container', (t) => {
  fakeDdev(t, 'running')
  const dir = ddevProject({ platform: FOREIGN })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const step = reactTs.build?.(context(dir))
  assert.equal(step?.cmd, 'ddev')
  assert.deepEqual(step?.args, [...IN_CONTAINER, 'npm', 'run', '--silent', 'build'])
})

test('tests: test_command läuft im Container', (t) => {
  fakeDdev(t, 'running')
  const dir = ddevProject({ platform: FOREIGN })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const ctx = context(dir)
  ctx.component.testCommand = 'npx vitest run --project unit'
  const step = reactTs.test?.(ctx)
  assert.equal(step?.cmd, 'ddev')
  assert.deepEqual(step?.args, [...IN_CONTAINER, 'npx', 'vitest', 'run', '--project', 'unit'])
})

for (const [verb, tool, rest] of /** @type {const} */ ([
  ['fmt', 'prettier', ['--check', '--ignore-unknown', 'app.ts']],
  ['lint', 'oxlint', ['app.ts']],
  ['types', 'tsc', ['--noEmit']],
])) {
  test(`${verb}: ${tool} läuft im Container`, (t) => {
    // oxlint ist selbst ein natives Paket. Eine Regel für alle Schritte ist
    // sicherer als eine Liste der Werkzeuge, die gerade native Teile haben.
    fakeDdev(t, 'running')
    const dir = ddevProject({ platform: FOREIGN })
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const step = reactTs[verb]?.(context(dir, { files: ['app.ts'] }))
    assert.equal(step?.cmd, 'ddev')
    assert.deepEqual(step?.args, [...IN_CONTAINER, `node_modules/.bin/${tool}`, ...rest])
  })
}
