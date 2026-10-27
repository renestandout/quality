import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { delimiter, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'

/** @import { Kind } from './types.mjs' */

/** @typedef {'npm' | 'pnpm' | 'yarn'} PackageManager */

/**
 * Werkzeuge finden und richtig aufrufen.
 *
 * Der zweite Teil ist nicht selbstverständlich: npm und pnpm reichen
 * Argumente an ein Skript unterschiedlich weiter, und wer das rät, misst
 * still das Falsche. Die Regeln stehen deshalb in reinen Funktionen mit
 * Tests, nicht verstreut in den Stack-Adaptern.
 */

/**
 * Findet ein Werkzeug in der Reihenfolge Komponente → Repo-Wurzel → PATH.
 * Gibt null zurück, wenn nichts gefunden wurde; der Aufrufer entscheidet, ob
 * das ein Fehler ist oder der Schritt einfach entfällt.
 *
 * @param {string} name
 * @param {{ dir?: string | null | undefined, root?: string | null | undefined, kind: Kind }} where
 * @returns {string | null}
 */
export function findBinary(name, { dir, root, kind }) {
  const relative = LOCAL_BIN[kind]?.(name) ?? join('node_modules', '.bin', name)
  for (const base of [dir, root]) {
    if (!base) continue
    const candidate = join(base, relative)
    if (existsSync(candidate)) return candidate
  }
  // Nur Python: ruff und mypy werden regelmässig global installiert (pipx,
  // Homebrew), und ein Projekt-venv ist dort keine Pflicht. Bei PHP und JS
  // bleibt es beim Projektpfad — ein global installiertes Pint hätte eine
  // andere Version als die, gegen die das Projekt aufgelöst hat.
  if (kind === 'py' && hasOnPath(name)) return name
  return null
}

/**
 * Wo ein Stack seine Werkzeuge lokal installiert.
 *
 * @type {Record<Kind, (name: string) => string>}
 */
const LOCAL_BIN = {
  php: (name) => join('vendor', 'bin', name),
  js: (name) => join('node_modules', '.bin', name),
  py: (name) => join('.venv', 'bin', name),
}

/**
 * Meldung, die sagt, was fehlt und wie man es behebt.
 *
 * @param {string} name
 * @param {Kind} kind
 * @returns {string}
 */
export function missingToolHint(name, kind) {
  const pkg = PACKAGE_FOR[name] ?? name
  const how =
    kind === 'php'
      ? `composer require --dev ${pkg}`
      : kind === 'py'
        ? `pip install ${pkg}`
        : `npm install -D ${pkg}`
  return `Werkzeug "${name}" nicht gefunden. Installieren mit:  ${how}`
}

/** @type {Record<string, string>} */
const PACKAGE_FOR = {
  pint: 'laravel/pint',
  phpstan: 'phpstan/phpstan larastan/larastan',
  prettier: 'prettier',
  oxlint: 'oxlint',
  tsc: 'typescript',
  vitest: 'vitest',
  ruff: 'ruff',
  mypy: 'mypy',
  pytest: 'pytest',
}

/* ── PHP in ddev ──────────────────────────────────────────────────────── */

/** Dort mountet ddev das Projekt im web-Container. */
const DDEV_APPROOT = '/var/www/html'

/**
 * Wie ein PHP-Werkzeug aus vendor/bin oder ein PHP-Befehl wie "php artisan
 * test" aufgerufen wird: im ddev-Container oder auf dem Host.
 *
 * vendor/bin/pint beginnt mit "#!/usr/bin/env php". Fehlt PHP auf dem Host,
 * endet der Aufruf mit "env: php: No such file or directory" und exit 127.
 * Projekte wie rankscan verbieten PHP auf dem Host; dort läuft PHP nur in
 * ddev, mit der Version aus .ddev/config.yaml.
 *
 * Die Reihenfolge:
 * 1. ddev-Projekt und ddev läuft: Aufruf im Container.
 * 2. Sonst PHP auf dem Host: Aufruf auf dem Host wie bisher. So läuft CI,
 *    wo .ddev/config.yaml im Repo liegt, ddev aber fehlt.
 * 3. Sonst: ein Schritt, der klar sagt, was fehlt.
 *
 * "ddev exec" startet ein gestopptes Projekt von selbst. Ein Hook nach jedem
 * Edit darf das nicht auslösen. Deshalb fragt der Adapter vorher den Status ab.
 *
 * @param {string} tool absoluter Pfad aus findBinary oder ein Befehlsname
 *   wie "php", den der Container selbst im PATH findet
 * @param {string[]} args
 * @param {string} dir Arbeitsverzeichnis der Komponente
 * @returns {{ cmd: string, args: string[] }}
 */
export function phpCommand(tool, args, dir) {
  const ddevRoot = findDdevRoot(dir)
  if (ddevRoot && ddevRunning(ddevRoot)) {
    const inside = relative(ddevRoot, dir)
    const containerDir = inside ? posix.join(DDEV_APPROOT, ...inside.split(sep)) : DDEV_APPROOT
    // --raw: ohne bash im Container, sonst zerfallen Dateinamen mit Leerzeichen.
    return {
      cmd: 'ddev',
      args: [
        'exec',
        '--raw',
        '--dir',
        containerDir,
        '--',
        isAbsolute(tool) ? relative(dir, tool) : tool,
        ...args,
      ],
    }
  }
  if (!ddevRoot || onHostPath('php')) return { cmd: tool, args }
  return failingCommand(
    `PHP fehlt auf dem Host, und ddev läuft nicht (${ddevRoot}).\n` +
      `Starte das Projekt mit:  ddev start\n`,
  )
}

/**
 * Sucht .ddev/config.yaml ab einem Verzeichnis aufwärts.
 *
 * @param {string} startDir
 * @returns {string | null}
 */
export function findDdevRoot(startDir) {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, '.ddev', 'config.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Läuft das ddev-Projekt? Fehlt ddev oder scheitert die Abfrage, gilt es als
 * nicht laufend.
 *
 * @param {string} ddevRoot
 * @returns {boolean}
 */
function ddevRunning(ddevRoot) {
  try {
    const out = execFileSync('ddev', ['describe', '-j'], {
      cwd: ddevRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
    return JSON.parse(out)?.raw?.status === 'running'
  } catch {
    return false
  }
}

/**
 * Liegt eine Datei dieses Namens im PATH? Bewusst ohne Aufruf und ohne
 * Merken: "env php" sucht genauso, und der Status kann sich zwischen zwei
 * Läufen ändern.
 *
 * @param {string} name
 * @returns {boolean}
 */
function onHostPath(name) {
  return (process.env.PATH ?? '')
    .split(delimiter)
    .some((entry) => entry && existsSync(join(entry, name)))
}

/**
 * Ein Aufruf, der nur eine Meldung ausgibt und mit exit 1 endet. So trägt der
 * Schritt die Meldung, ohne dass Runner und Audit einen neuen Schritttyp
 * kennen müssen.
 *
 * @param {string} message
 * @returns {{ cmd: string, args: string[] }}
 */
export function failingCommand(message) {
  return {
    cmd: process.execPath,
    args: ['-e', 'process.stderr.write(process.argv[1]); process.exit(1)', message],
  }
}

/* ── Paketmanager ─────────────────────────────────────────────────────── */

/** @type {PackageManager[]} */
export const PACKAGE_MANAGERS = ['npm', 'pnpm', 'yarn']

/** Lockfiles, an denen sich ein JS-Projekt erkennen lässt. */
export const JS_LOCKFILES = [
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
]

/**
 * Welcher Paketmanager ein JS-Projekt treibt.
 *
 * Das Feld `packageManager` im package.json entscheidet zuerst: Corepack
 * liest genau dieses Feld, und es nennt die Absicht statt eines Nebenprodukts.
 * Erst danach zählt das Lockfile. Liegen zwei Lockfiles nebeneinander, gewinnt
 * npm — ein Zustand, den niemand absichtlich herstellt; wichtiger als die Wahl
 * ist, dass sie feststeht und nicht von der Verzeichnisreihenfolge abhängt.
 *
 * Gibt null zurück, wenn nichts entschied. Das ist eine andere Aussage als
 * "npm", und jeder Aufrufer setzt seinen eigenen Standard.
 *
 * @param {{declared?: string|null, lockfiles?: string[]}} facts
 * @returns {PackageManager | null}
 */
export function packageManagerFrom({ declared = null, lockfiles = [] } = {}) {
  const name = String(declared ?? '')
    .split('@')[0]
    ?.trim()
  const named = PACKAGE_MANAGERS.find((pm) => pm === name)
  if (named) return named

  const present = new Set(lockfiles)
  if (present.has('package-lock.json') || present.has('npm-shrinkwrap.json')) return 'npm'
  if (present.has('pnpm-lock.yaml')) return 'pnpm'
  if (present.has('yarn.lock')) return 'yarn'
  return null
}

/**
 * @param {string} file
 * @returns {any} ungeprüftes JSON; die Aufrufer greifen nur optional darauf zu
 */
export function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Sammelt die Fakten von der Platte, Komponente vor Repo-Wurzel — dieselbe
 * Reihenfolge wie findBinary. Der Rückfall auf die Wurzel ist Pflicht: in
 * einem pnpm-Monorepo liegt das Lockfile nur dort, und ohne ihn fiele jede
 * Unterkomponente auf npm zurück.
 *
 * @param {string | null | undefined} dir
 * @param {string | null | undefined} root
 * @returns {PackageManager | null}
 */
export function packageManagerFor(dir, root) {
  for (const base of [dir, root]) {
    if (!base) continue
    const declared = readJson(join(base, 'package.json'))?.packageManager ?? null
    const lockfiles = JS_LOCKFILES.filter((f) => existsSync(join(base, f)))
    const pm = packageManagerFrom({ declared, lockfiles })
    if (pm) return pm
  }
  return null
}

/** @type {Map<string, boolean>} */
const onPath = new Map()

/**
 * Liegt das Werkzeug im PATH? Einmal je Prozess geprüft, dann gemerkt.
 *
 * Nötig, weil lib/run.mjs mit `shell: false` startet: ein fehlendes `pnpm`
 * bricht den Schritt mit Exit 127 ab, statt auf npm auszuweichen. Auf Renés
 * Rechner fehlen pnpm, yarn und corepack — der Rückfall ist kein Randfall.
 *
 * @param {string} name
 * @returns {boolean}
 */
export function hasOnPath(name) {
  let found = onPath.get(name)
  if (found === undefined) {
    try {
      execFileSync(name, ['--version'], { stdio: 'ignore' })
      found = true
    } catch {
      found = false
    }
    onPath.set(name, found)
  }
  return found
}

/**
 * Der Aufruf eines Projekt-Skripts, samt Weitergabe zusätzlicher Argumente.
 *
 * Gemessen am 20.08.2026 mit npm 11.12.1 und pnpm 9.12:
 *   npm  run --silent lint --version     → npm meldet SEINE Version (11.12.1)
 *   npm  run --silent lint -- --version  → eslint meldet seine (v9.39.4)
 *   pnpm run --silent lint --version     → eslint meldet seine (v9.39.4)
 *   pnpm run --silent lint -- --version  → eslint bekommt "--" als Trenner
 *
 * npm braucht das `--` also zwingend, pnpm darf es auf keinen Fall bekommen.
 * Ohne diese Unterscheidung schluckt npm die Schärfe-Option stillschweigend.
 *
 * @param {PackageManager | string | null} pm unbekannte Werte fallen auf npm zurück
 * @param {string} script
 * @param {string[]} [args]
 * @returns {{ cmd: string, args: string[] }}
 */
export function scriptCommand(pm, script, args = []) {
  if (pm === 'pnpm') return { cmd: 'pnpm', args: ['run', '--silent', script, ...args] }
  // yarn ist ungetestet — kein Standout-Projekt nutzt es. `--silent` bleibt
  // weg, weil yarn berry die Option nicht kennt.
  if (pm === 'yarn') return { cmd: 'yarn', args: ['run', script, ...args] }
  const forward = args.length > 0 ? ['--', ...args] : []
  return { cmd: 'npm', args: ['run', '--silent', script, ...forward] }
}

/* ── Linter-Schärfe ───────────────────────────────────────────────────── */

/**
 * Die Option, mit der ein Linter Warnungen als Fehler wertet. Eine Tabelle,
 * damit der direkte Aufruf und der Aufruf über das lint-Skript dieselbe
 * Wahrheit benutzen.
 */
/** @type {Record<'eslint' | 'oxlint', string>} */
export const LINT_STRICT_FLAG = { eslint: '--max-warnings=0', oxlint: '--deny-warnings' }

/**
 * Welche Option ein fremdes lint-Skript scharf stellt — oder null, wenn sich
 * das nicht sicher sagen lässt.
 *
 * Verkettete Skripte bleiben unangetastet: ein weitergereichtes Argument
 * landet nur beim LETZTEN Befehl der Kette. Halb scharf ist schlechter als
 * offen nicht scharf, weil es dasselbe grüne Häkchen erzeugt.
 *
 * @param {unknown} script
 * @returns {string[] | null}
 */
export function lintStrictArgs(script) {
  const text = String(script ?? '')
  if (/&&|\|\||[;|]/.test(text)) return null
  if (/(^|[\s/])oxlint(\s|$)/.test(text)) return [LINT_STRICT_FLAG.oxlint]
  // "next lint" reicht eslint-Optionen durch, enthält aber nicht "eslint".
  if (/(^|[\s/])eslint(\s|$)/.test(text) || /(^|[\s/])next\s+lint(\s|$)/.test(text)) {
    return [LINT_STRICT_FLAG.eslint]
  }
  return null
}
