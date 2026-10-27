import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runStep } from '../lib/run.mjs'
import python from './python.mjs'

/** @import { StackContext, Step } from '../lib/types.mjs' */

/**
 * Ein Python-Projekt mit deklarierten Abhängigkeiten, aber ohne .venv — so
 * wie ein frischer Worktree vor "uv sync".
 *
 * @param {import('node:test').TestContext} t
 * @param {{ pyproject?: string }} [options]
 * @returns {string}
 */
function uninstalled(t, { pyproject } = {}) {
  // Ein aktiviertes venv der Testumgebung zählte sonst als installiert.
  const active = process.env.VIRTUAL_ENV
  delete process.env.VIRTUAL_ENV
  const dir = mkdtempSync(join(tmpdir(), 'quality-python-no-venv-'))
  t.after(() => {
    if (active !== undefined) process.env.VIRTUAL_ENV = active
    rmSync(dir, { recursive: true, force: true })
  })
  writeFileSync(
    join(dir, 'pyproject.toml'),
    pyproject ??
      '[project]\nname = "app"\ndependencies = ["requests>=2"]\n\n' +
        '[dependency-groups]\ndev = ["ruff", "mypy", "pytest"]\n\n[tool.ruff]\n[tool.mypy]\n',
  )
  mkdirSync(join(dir, 'tests'))
  writeFileSync(join(dir, 'tests', 'test_app.py'), 'def test_app():\n    assert True\n')
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
    component: { path: '.', stack: 'python', kind: 'py' },
    config: {},
    files: null,
    check: true,
    full: true,
    ...extra,
  })
}

/**
 * Führt einen Schritt aus, der scheitern soll, und gibt seine Ausgabe zurück.
 *
 * @param {Step | null | undefined} step
 */
async function failing(step) {
  assert.ok(step && !step.skip, 'der Schritt ist ausführbar, nicht übersprungen')
  const result = await runStep(step, { quiet: true })
  assert.equal(result.code, 1)
  return result.output
}

/**
 * Scheitert der Schritt an der fehlenden Installation? Ein Skip oder ein
 * Werkzeugaufruf heisst: nein.
 *
 * @param {Step | null | undefined} step
 */
const blocksOnInstall = (step) => step?.cmd === process.execPath

for (const verb of /** @type {const} */ (['fmt', 'lint', 'types', 'test'])) {
  test(`${verb}: ohne .venv scheitert der Schritt mit einem Installationshinweis`, async (t) => {
    // Bisher entfielen ruff, mypy und pytest still, und das Projekt bestand
    // das Gate mit "0 Prüfungen bestanden", exit 0.
    const dir = uninstalled(t)

    const output = await failing(python[verb]?.(context(dir)))
    assert.match(output, /\.venv fehlt/)
    assert.match(output, /pip install -e \./)
  })
}

test('lint: mit uv.lock nennt der Hinweis uv sync', async (t) => {
  const dir = uninstalled(t)
  writeFileSync(join(dir, 'uv.lock'), '')

  const output = await failing(python.lint?.(context(dir)))
  assert.match(output, /uv sync/)
})

test('lint: eine requirements.txt zählt als deklarierte Abhängigkeit', async (t) => {
  const dir = uninstalled(t, { pyproject: '[project]\nname = "app"\n' })
  writeFileSync(join(dir, 'requirements.txt'), '# Laufzeit\nrequests>=2\n')

  const output = await failing(python.lint?.(context(dir)))
  assert.match(output, /pip install -r requirements\.txt/)
})

test('lint: Poetry-Abhängigkeiten zählen als deklariert', async (t) => {
  const dir = uninstalled(t, {
    pyproject: '[tool.poetry.dependencies]\npython = "^3.12"\nrequests = "^2"\n',
  })

  await failing(python.lint?.(context(dir)))
})

test('lint: ein pyproject.toml ohne Abhängigkeiten braucht kein .venv', (t) => {
  // Dann genügen Werkzeuge im PATH, etwa ruff aus pipx oder Homebrew.
  const dir = uninstalled(t, { pyproject: '[project]\nname = "app"\ndependencies = []\n' })

  assert.equal(blocksOnInstall(python.lint?.(context(dir))), false)
})

test('lint: .venv der Repo-Wurzel genügt einer Unterkomponente', (t) => {
  const root = uninstalled(t)
  mkdirSync(join(root, '.venv', 'bin'), { recursive: true })
  writeFileSync(join(root, '.venv', 'pyvenv.cfg'), '')
  writeFileSync(join(root, '.venv', 'bin', 'ruff'), '')
  const dir = join(root, 'api')
  mkdirSync(dir)
  writeFileSync(join(dir, 'pyproject.toml'), '[project]\ndependencies = ["requests"]\n')

  const step = python.lint?.(context(dir, { root }))
  assert.equal(step?.cmd, join(root, '.venv', 'bin', 'ruff'))
})

test('lint: ein aktiviertes venv (VIRTUAL_ENV) gilt als installiert', (t) => {
  const dir = uninstalled(t)
  process.env.VIRTUAL_ENV = join(dir, 'anderswo')

  assert.equal(blocksOnInstall(python.lint?.(context(dir))), false)
})

test('types: mit .venv, aber ohne mypy, entfällt der Schritt weiterhin', (t) => {
  // Fehlt nur ein Werkzeug, nutzt das Projekt es nicht. Das bleibt ein Skip.
  const dir = uninstalled(t)
  mkdirSync(join(dir, '.venv', 'bin'), { recursive: true })
  writeFileSync(join(dir, '.venv', 'pyvenv.cfg'), '')

  const step = python.types?.(context(dir))
  assert.equal(blocksOnInstall(step), false)
  assert.ok(step?.skip)
})

test('test: ein eigener Testbefehl läuft auch ohne .venv unverändert', (t) => {
  // Der Befehl aus quality.yml gehört dem Projekt, wie bei den anderen Stacks.
  const dir = uninstalled(t)

  const component = /** @type {StackContext['component']} */ ({
    path: '.',
    stack: 'python',
    testCommand: 'uv run pytest',
  })
  const step = python.test?.(context(dir, { component }))
  assert.equal(step?.cmd, 'uv')
})
