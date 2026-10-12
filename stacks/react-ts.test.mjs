import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
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
