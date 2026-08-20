/**
 * Erkennt, woraus ein Repository besteht.
 *
 * Grundlage sind ausschliesslich die Manifest-Dateien (composer.json,
 * package.json, pyproject.toml und Verwandte) — nicht der Inhalt des Codes. Das ist bewusst grob: die
 * Erkennung soll einen Vorschlag machen, den ein Mensch bestätigt, und nicht
 * versuchen, klüger zu sein als die Projektstruktur.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, relative } from 'node:path'

/** Verzeichnisse, in denen nie eine Komponente steckt. */
const SKIP_DIRS = new Set([
  'node_modules',
  'vendor',
  '.git',
  '.github',
  'dist',
  'build',
  'public',
  'storage',
  'bootstrap',
  '.next',
  '.nuxt',
  'coverage',
  'tmp',
  'var',
  '.venv',
  'venv',
])

const MAX_DEPTH = 3

function readJson(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Leitet den Stack aus den Manifesten eines Verzeichnisses ab.
 *
 * Liegen composer.json und package.json nebeneinander, gewinnt composer:
 * ein Laravel-Projekt hat fast immer beides, aber das package.json bündelt
 * dort nur Assets und ist keine eigene Komponente.
 *
 * Nur wenn es auch PHP-Code gibt. Ein Node-Werkzeug kann eine composer.json
 * mitliefern, um sich per Composer installieren zu lassen — dieses Framework
 * selbst ist das Beispiel. Es dann als PHP-Projekt zu prüfen, misst nichts.
 */
export function stackFromManifests({ composer = null, pkg = null, python = null, hasPhpSources = true } = {}) {
  if (composer && (hasPhpSources || !pkg)) {
    const deps = { ...composer.require, ...composer['require-dev'] }
    if (deps['laravel/framework']) return 'laravel'
    return 'php'
  }
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps.next) return 'next-ts'
    if (deps.react || deps['react-dom']) return 'react-ts'
    return 'node-ts'
  }
  // Python steht zuletzt, weil ein Manifest hier viel schwaecher ist als
  // drueben: eine pytest.ini sagt nur, dass jemand Tests fahren wollte. Liegt
  // sie neben einem package.json, ist das JS-Projekt die Komponente und die
  // Tests gehoeren zu seinem Werkzeug.
  if (python) return 'python'
  return null
}

/**
 * Dateien, an denen ein Python-Projekt erkennbar ist.
 *
 * Bewusst breiter als bei den anderen Stacks: `pyproject.toml` ist zwar der
 * heutige Standard, aber gewachsene Skript-Repos haben oft nur eine
 * pytest.ini oder eine requirements.txt. agent-desk ist genau so eins.
 */
export const PYTHON_MANIFESTS = [
  'pyproject.toml',
  'setup.cfg',
  'setup.py',
  'pytest.ini',
  'tox.ini',
  'Pipfile',
  'requirements.txt',
]

/** Das erste vorhandene Python-Manifest eines Verzeichnisses, sonst null. */
export function pythonManifest(dir) {
  return PYTHON_MANIFESTS.find((f) => existsSync(join(dir, f))) ?? null
}

/** Zusatzfakten, die im Report stehen und die Empfehlung begründen. */
export function factsFromManifests({ composer = null, pkg = null, python = null } = {}) {
  const facts = {}
  if (python) facts.pythonManifest = python
  if (composer) {
    const deps = { ...composer.require, ...composer['require-dev'] }
    /*
     * `config.platform.php` zuerst: das ist die Version, gegen die Composer
     * auflöst, und damit die verlässlichste Angabe im Manifest.
     *
     * Der Constraint aus `require` ist nur eine Mindestangabe und hinkt gern
     * hinterher — bei adboard stand dort ^8.3, während die composer.lock
     * faktisch 8.4.1 verlangte und das Image 8.4 fährt. Wer sich darauf
     * verlässt, misst mit der falschen Sprachversion.
     */
    const platform = composer.config?.platform?.php
    if (platform) {
      facts.php = platform
      facts.phpFrom = 'platform'
    } else if (deps.php) {
      facts.php = deps.php
      facts.phpFrom = 'constraint'
    }
    if (deps['laravel/framework']) facts.laravel = deps['laravel/framework']
    facts.hasPint = Boolean(deps['laravel/pint'])
    facts.hasPhpstan = Boolean(deps['phpstan/phpstan'] || deps['larastan/larastan'] || deps['nunomaduro/larastan'])
  }
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    if (deps.typescript) facts.typescript = deps.typescript
    if (deps.react) facts.react = deps.react
    facts.hasPrettier = Boolean(deps.prettier)
    facts.hasLinter = Boolean(deps.eslint || deps.oxlint || deps['eslint-config-next'])
    facts.hasTestRunner = Boolean(deps.vitest || deps.jest || deps['@playwright/test'])
    facts.scripts = Object.keys(pkg.scripts ?? {})
  }
  return facts
}

/** Verzeichnisse, in denen PHP-Code üblicherweise liegt. */
const PHP_SOURCE_DIRS = ['app', 'src', 'lib', 'database', 'routes', 'classes', 'includes']

/**
 * Verzeichnisse, die PHPStan analysiert.
 *
 * Eine einzige Liste für Messung und erzeugte Konfiguration. Zwei Listen
 * bedeuten, dass der Audit einen anderen Umfang misst, als später im Betrieb
 * geprüft wird — die Zahl im Bericht wäre dann systematisch falsch.
 *
 * `config/` steht bewusst nicht darin: Laravels Konfigurationsdateien sind
 * Arrays mit `env()`-Aufrufen, die dort erlaubt und überall sonst verboten
 * sind. Sie mitzuanalysieren erzeugt Meldungen ohne Erkenntnis.
 */
export const PHP_ANALYSE_PATHS = ['app', 'src', 'lib', 'database', 'routes']

function containsPhp(dir, depth = 0) {
  let entries = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith('.php')) return true
  }
  if (depth >= 2) return false
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    if (containsPhp(join(dir, entry.name), depth + 1)) return true
  }
  return false
}

/**
 * Prüft, ob in diesem Verzeichnis überhaupt PHP-Code liegt.
 * Gefragt sind zuerst die Autoload-Ziele der composer.json — sie sagen am
 * genauesten, wo der Code des Pakets steht.
 */
export function hasPhpSources(dir, composer) {
  const targets = new Set(PHP_SOURCE_DIRS)
  const autoload = { ...composer?.autoload, ...composer?.['autoload-dev'] }
  for (const map of [autoload['psr-4'], autoload['psr-0']]) {
    for (const value of Object.values(map ?? {})) {
      for (const path of Array.isArray(value) ? value : [value]) targets.add(path)
    }
  }
  for (const path of autoload.classmap ?? []) targets.add(path)

  for (const target of targets) {
    const full = join(dir, target)
    if (existsSync(full) && containsPhp(full)) return true
  }
  // Ein Projekt kann seine PHP-Dateien auch direkt in der Wurzel haben.
  try {
    return readdirSync(dir).some((f) => f.endsWith('.php'))
  } catch {
    return false
  }
}

/**
 * Durchsucht ein Repository nach Komponenten.
 * Sobald ein Verzeichnis eine Komponente ist, wird nicht weiter hinein
 * gestiegen — ein Laravel-Projekt enthält Unterordner mit eigenem
 * package.json, die trotzdem keine eigene Komponente sind.
 */
export function detectComponents(root) {
  const found = []

  const visit = (dir, depth) => {
    const composerFile = join(dir, 'composer.json')
    const pkgFile = join(dir, 'package.json')
    const composer = existsSync(composerFile) ? readJson(composerFile) : null
    const pkg = existsSync(pkgFile) ? readJson(pkgFile) : null
    const python = pythonManifest(dir)
    const stack = stackFromManifests({
      composer,
      pkg,
      python,
      hasPhpSources: composer ? hasPhpSources(dir, composer) : false,
    })

    if (stack) {
      const path = relative(root, dir) || '.'
      found.push({ path, stack, facts: factsFromManifests({ composer, pkg, python }), dir })
      return
    }

    if (depth >= MAX_DEPTH) return
    let entries = []
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      visit(join(dir, entry.name), depth + 1)
    }
  }

  visit(root, 0)
  return found
}
