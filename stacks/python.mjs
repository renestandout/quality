import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { findBinary, missingToolHint } from '../lib/tools.mjs'

/**
 * Python-Stack.
 *
 * ruff übernimmt Formatierung und Linting in einem Werkzeug — es ersetzt
 * black, isort und flake8 und ist schnell genug für den Editor-Hook. Die
 * Typprüfung macht mypy.
 *
 * Anders als bei den JS-Stacks wird hier kein Projekt-Skript aufgerufen:
 * Python kennt keine allgemein übliche Skript-Tabelle wie package.json, und
 * ein Makefile-Ziel zu raten misst still das Falsche.
 */

/** Dateien, in denen eine Werkzeugkonfiguration stehen kann. */
const RUFF_FILES = ['ruff.toml', '.ruff.toml']
const MYPY_FILES = ['mypy.ini', '.mypy.ini']

/**
 * Findet die Konfiguration eines Werkzeugs — als eigene Datei, in setup.cfg
 * oder als `[tool.<name>]`-Abschnitt der pyproject.toml.
 *
 * Die Prüfung ist wichtiger, als sie aussieht: ohne Konfiguration läuft ruff
 * mit einem Minimalregelsatz (E4, E7, E9, F) und mypy ohne jede Strenge. Das
 * Gate wäre grün und prüfte fast nichts — dieselbe Falle, die bei
 * rankscan/application vier Wochen lang eine fremde phpstan.neon aktiv liess.
 */
function findConfig(dir, { files, section }) {
  const own = files.find((f) => existsSync(join(dir, f)))
  if (own) return own
  for (const [file, marker] of [
    ['pyproject.toml', `[tool.${section}`],
    ['setup.cfg', `[${section}`],
  ]) {
    const full = join(dir, file)
    if (!existsSync(full)) continue
    try {
      if (readFileSync(full, 'utf8').includes(marker)) return file
    } catch {
      // Unlesbare Datei zählt wie keine — der Schritt sagt es dann.
    }
  }
  return null
}

const TEST_NAME = /^(test_.*|.*_test)\.py$/

/**
 * Hat die Komponente überhaupt Tests?
 *
 * pytest beendet mit Exit 5, wenn es nichts sammelt — für den Runner ein
 * Fehlschlag. Ein Projekt ohne Tests soll das Gate aber nicht blockieren,
 * sondern den Schritt sichtbar überspringen.
 */
function hasTests(dir) {
  for (const name of ['tests', 'test']) {
    if (existsSync(join(dir, name))) return true
  }
  try {
    return readdirSync(dir).some((f) => TEST_NAME.test(f))
  } catch {
    return false
  }
}

const isTestFile = (f) => TEST_NAME.test(f.split('/').pop() ?? '')

/** Ziel eines Werkzeugs: die geänderten Dateien, sonst das ganze Verzeichnis. */
const targets = (ctx) => (ctx.files?.length ? ctx.files : ['.'])

export default {
  name: 'python',
  kind: 'py',

  fmt(ctx) {
    const tool = findBinary('ruff', { dir: ctx.dir, root: ctx.root, kind: 'py' })
    if (!tool) return { name: 'ruff format', skip: missingToolHint('ruff', 'py') }
    return {
      name: `ruff format${ctx.check ? ' (prüfend)' : ''} (${ctx.component.path})`,
      cmd: tool,
      args: ['format', ...(ctx.check ? ['--check'] : []), ...targets(ctx)],
      cwd: ctx.dir,
    }
  },

  lint(ctx) {
    const tool = findBinary('ruff', { dir: ctx.dir, root: ctx.root, kind: 'py' })
    if (!tool) return { name: 'ruff check', skip: missingToolHint('ruff', 'py') }
    const config = findConfig(ctx.dir, { files: RUFF_FILES, section: 'ruff' })
    return {
      name: `ruff check (${ctx.component.path})`,
      cmd: tool,
      // --no-fix ist ab `task` ohnehin gesetzt, hier aber immer: der Linter
      // schreibt in keiner Stufe am Code, das tut allein `ruff format`.
      args: ['check', '--no-fix', ...targets(ctx)],
      cwd: ctx.dir,
      note: config
        ? undefined
        : 'keine ruff-Konfiguration gefunden — es gilt der Minimalregelsatz (E4, E7, E9, F)',
    }
  },

  types(ctx) {
    const tool = findBinary('mypy', { dir: ctx.dir, root: ctx.root, kind: 'py' })
    if (!tool) return { name: 'mypy', skip: missingToolHint('mypy', 'py') }
    const config = findConfig(ctx.dir, { files: MYPY_FILES, section: 'mypy' })
    if (!config) {
      return {
        name: `mypy (${ctx.component.path})`,
        // Nicht "quality init legt sie an": init schreibt heute nur phpstan.neon.
        // Eine Zusage, die das Werkzeug nicht einloest, ist schlimmer als der
        // Verweis auf die Vorlage.
        skip: 'keine mypy-Konfiguration in der Komponente — Vorlage: configs/mypy.ini des Pakets kopieren',
      }
    }
    // strict ist bei mypy eine Sammeloption. Sie gehoert auf die Befehlszeile
    // und nicht in die Konfiguration, damit dasselbe Projekt unter beiden
    // Profilen laufen kann, ohne dass jemand die Datei tauscht.
    const strict = ctx.config?.level === 'strict' ? ['--strict'] : []
    return {
      name: `mypy${strict.length ? ' (strict)' : ''} (${ctx.component.path})`,
      cmd: tool,
      args: [...strict, '--no-error-summary', ...targets(ctx)],
      cwd: ctx.dir,
    }
  },

  test(ctx) {
    if (ctx.component.testCommand) {
      const [cmd, ...args] = ctx.component.testCommand.split(' ')
      return { name: `tests (${ctx.component.path})`, cmd, args, cwd: ctx.dir }
    }
    const tool = findBinary('pytest', { dir: ctx.dir, root: ctx.root, kind: 'py' })
    if (!tool) return { name: 'pytest', skip: missingToolHint('pytest', 'py') }
    if (!hasTests(ctx.dir)) return { name: 'pytest', skip: 'keine Tests in der Komponente gefunden' }
    // Geaenderte Quelldateien an pytest zu reichen, sammelt keine Tests und
    // endet mit Exit 5. Nur Testdateien zaehlen; ist keine dabei, laeuft die
    // ganze Suite — `test` gibt es ohnehin erst ab der Stufe `task`.
    const changed = ctx.files?.filter(isTestFile) ?? []
    return {
      name: `pytest (${ctx.component.path})`,
      cmd: tool,
      args: ['-q', ...changed],
      cwd: ctx.dir,
    }
  },

  build() {
    return null
  },
}
