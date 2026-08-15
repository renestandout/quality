/**
 * Erkennt, woraus ein Repository besteht.
 *
 * Grundlage sind ausschliesslich die Manifest-Dateien (composer.json,
 * package.json) — nicht der Inhalt des Codes. Das ist bewusst grob: die
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
export function stackFromManifests({ composer = null, pkg = null, hasPhpSources = true } = {}) {
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
  return null
}

/** Zusatzfakten, die im Report stehen und die Empfehlung begründen. */
export function factsFromManifests({ composer = null, pkg = null } = {}) {
  const facts = {}
  if (composer) {
    const deps = { ...composer.require, ...composer['require-dev'] }
    if (deps.php) facts.php = deps.php
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
    const stack = stackFromManifests({
      composer,
      pkg,
      hasPhpSources: composer ? hasPhpSources(dir, composer) : false,
    })

    if (stack) {
      const path = relative(root, dir) || '.'
      found.push({ path, stack, facts: factsFromManifests({ composer, pkg }), dir })
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
