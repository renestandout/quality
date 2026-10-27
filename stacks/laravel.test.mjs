import assert from 'node:assert/strict'
import {
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
import { runStep } from '../lib/run.mjs'
import laravel from './laravel.mjs'
import php from './php.mjs'

/** @import { StackContext, Step } from '../lib/types.mjs' */

/*
 * Der Host dieser Tests hat kein PHP: der PATH enthält nur einen Ordner mit
 * einem falschen "ddev". So lief der Edit-Hook in rankscan, als
 * vendor/bin/pint mit "env: php: No such file or directory" abbrach.
 */

/**
 * Ein Laravel-Projekt mit Pint, PHPStan-Konfiguration und optional ddev.
 *
 * @param {{ ddev?: boolean, component?: string }} [options]
 * @returns {{ root: string, dir: string }}
 */
function project({ ddev = true, component = '.' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quality-laravel-'))
  const dir = join(root, component)
  mkdirSync(join(dir, 'vendor', 'bin'), { recursive: true })
  writeFileSync(join(dir, 'vendor', 'bin', 'pint'), '#!/usr/bin/env php\n')
  writeFileSync(join(dir, 'vendor', 'bin', 'phpstan'), '#!/usr/bin/env php\n')
  writeFileSync(join(dir, 'phpstan.neon'), '')
  if (ddev) {
    mkdirSync(join(root, '.ddev'))
    writeFileSync(join(root, '.ddev', 'config.yaml'), 'name: demo\n')
  }
  return { root, dir }
}

/**
 * Ersetzt den PATH durch einen Ordner mit einem falschen "ddev". Das Skript
 * schreibt jeden Aufruf in ein Protokoll und meldet den gewünschten Status
 * im Format von "ddev describe -j".
 *
 * @param {import('node:test').TestContext} t
 * @param {{ status: string, php?: boolean }} options
 * @returns {{ calls: () => string[] }}
 */
function fakeHost(t, { status, php = false }) {
  const bin = mkdtempSync(join(tmpdir(), 'quality-fake-ddev-'))
  const log = join(bin, 'calls.log')
  writeFileSync(
    join(bin, 'ddev'),
    `#!/bin/sh
echo "$*" >> "${log}"
case "$1" in
  describe) printf '{"level":"info","msg":"","raw":{"status":"${status}"}}\\n' ;;
  exec) echo "im Container: $*" ;;
esac
`,
  )
  chmodSync(join(bin, 'ddev'), 0o755)
  if (php) {
    writeFileSync(join(bin, 'php'), '#!/bin/sh\n')
    chmodSync(join(bin, 'php'), 0o755)
  }
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

/**
 * @param {{ root: string, dir: string }} where
 * @param {Partial<StackContext>} [extra]
 * @returns {StackContext}
 */
function context({ root, dir }, extra = {}) {
  return /** @type {StackContext} */ ({
    dir,
    root,
    component: { path: '.', stack: 'laravel', kind: 'php', phpstanLevel: 5 },
    config: {},
    files: ['app/Models/User.php'],
    check: true,
    full: false,
    ...extra,
  })
}

/**
 * @param {Step | null | undefined} step
 * @returns {Step}
 */
function runnable(step) {
  assert.ok(step && !step.skip, 'der Adapter liefert einen ausführbaren Schritt')
  return step
}

test('pint: läuft ddev, ruft der Adapter pint im Container auf', async (t) => {
  const host = fakeHost(t, { status: 'running' })
  const where = project()
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const step = runnable(laravel.fmt?.(context(where)))
  assert.equal(step.cmd, 'ddev')
  assert.deepEqual(step.args, [
    'exec',
    '--raw',
    '--dir',
    '/var/www/html',
    '--',
    'vendor/bin/pint',
    '--test',
    'app/Models/User.php',
  ])

  const result = await runStep(step, { quiet: true })
  assert.equal(result.code, 0, result.output)
  assert.match(result.output, /im Container: exec/)
  assert.equal(host.calls().filter((c) => c.startsWith('exec')).length, 1)
})

test('pint: eine Komponente im Unterordner läuft im passenden Container-Verzeichnis', (t) => {
  fakeHost(t, { status: 'running' })
  const where = project({ component: 'backend' })
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const step = runnable(laravel.fmt?.(context(where)))
  assert.deepEqual(step.args?.slice(0, 6), [
    'exec',
    '--raw',
    '--dir',
    '/var/www/html/backend',
    '--',
    'vendor/bin/pint',
  ])
})

test('phpstan: läuft ddev, ruft der Adapter phpstan im Container auf', (t) => {
  fakeHost(t, { status: 'running' })
  const where = project()
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const step = runnable(laravel.types?.(context(where)))
  assert.equal(step.cmd, 'ddev')
  assert.deepEqual(step.args?.slice(0, 7), [
    'exec',
    '--raw',
    '--dir',
    '/var/www/html',
    '--',
    'vendor/bin/phpstan',
    'analyse',
  ])
  assert.equal(step.args?.at(-1), 'app/Models/User.php')
})

test('pint: ddev gestoppt und kein PHP auf dem Host — klare Meldung statt exit 127', async (t) => {
  // "ddev exec" startet ein gestopptes Projekt von selbst. Das darf ein Hook
  // nach jedem Edit nicht auslösen.
  const host = fakeHost(t, { status: 'stopped' })
  const where = project()
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const result = await runStep(runnable(laravel.fmt?.(context(where))), { quiet: true })
  assert.equal(result.code, 1)
  assert.match(result.output, /ddev läuft nicht/)
  assert.match(result.output, /ddev start/)
  assert.deepEqual(
    host.calls().filter((c) => c.startsWith('exec')),
    [],
  )
})

test('phpstan: ddev gestoppt und kein PHP auf dem Host — klare Meldung statt exit 127', async (t) => {
  fakeHost(t, { status: 'stopped' })
  const where = project()
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const result = await runStep(runnable(laravel.types?.(context(where))), { quiet: true })
  assert.equal(result.code, 1)
  assert.match(result.output, /ddev läuft nicht/)
})

test('pint: ddev gestoppt, aber PHP auf dem Host — Aufruf auf dem Host wie bisher', (t) => {
  // So läuft CI: .ddev/config.yaml liegt im Repo, ddev gibt es dort nicht.
  fakeHost(t, { status: 'stopped', php: true })
  const where = project()
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const step = runnable(laravel.fmt?.(context(where)))
  assert.equal(step.cmd, join(where.dir, 'vendor', 'bin', 'pint'))
})

test('pint: ohne ddev-Projekt fragt der Adapter ddev gar nicht erst', (t) => {
  const host = fakeHost(t, { status: 'running' })
  const where = project({ ddev: false })
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const step = runnable(laravel.fmt?.(context(where)))
  assert.equal(step.cmd, join(where.dir, 'vendor', 'bin', 'pint'))
  assert.deepEqual(host.calls(), [])
})

test('tests: läuft ddev, startet der Adapter test_command im Container', (t) => {
  // Auf dem Host scheiterte rankscan am memory_limit von 128M und am DB-Host
  // "db", den es nur im ddev-Netz gibt.
  fakeHost(t, { status: 'running', php: true })
  const where = project()
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const ctx = context(where)
  ctx.component.testCommand = 'php artisan test --parallel --processes=3'
  const step = runnable(laravel.test?.(ctx))
  assert.equal(step.cmd, 'ddev')
  assert.deepEqual(step.args, [
    'exec',
    '--raw',
    '--dir',
    '/var/www/html',
    '--',
    'php',
    'artisan',
    'test',
    '--parallel',
    '--processes=3',
  ])
})

test('tests: ddev gestoppt, aber PHP auf dem Host — test_command auf dem Host wie bisher', (t) => {
  // So läuft CI: .ddev/config.yaml liegt im Repo, ddev gibt es dort nicht.
  fakeHost(t, { status: 'stopped', php: true })
  const where = project()
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const ctx = context(where)
  ctx.component.testCommand = 'php artisan test'
  const step = runnable(laravel.test?.(ctx))
  assert.equal(step.cmd, 'php')
  assert.deepEqual(step.args, ['artisan', 'test'])
})

test('tests: ohne test_command startet der Adapter artisan test im Container', (t) => {
  fakeHost(t, { status: 'running' })
  const where = project()
  writeFileSync(join(where.dir, 'artisan'), '')
  t.after(() => rmSync(where.root, { recursive: true, force: true }))

  const step = runnable(laravel.test?.(context(where)))
  assert.equal(step.cmd, 'ddev')
  assert.deepEqual(step.args?.slice(4), ['--', 'php', 'artisan', 'test'])
})

/**
 * Ein Laravel-Projekt mit composer.json und composer.lock, aber ohne vendor —
 * so wie ein frischer Worktree vor "composer install".
 *
 * @param {{ ddev?: boolean, require?: Record<string, string> }} [options]
 * @returns {string}
 */
function uninstalled({ ddev = false, require } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-laravel-no-vendor-'))
  const manifest = {
    require: require ?? { php: '^8.3', 'laravel/framework': '^11.0' },
    'require-dev': require ? {} : { 'laravel/pint': '^1.0', 'larastan/larastan': '^2.0' },
  }
  writeFileSync(join(dir, 'composer.json'), JSON.stringify(manifest))
  writeFileSync(join(dir, 'composer.lock'), '{}')
  writeFileSync(join(dir, 'phpstan.neon'), '')
  writeFileSync(join(dir, 'artisan'), "<?php require __DIR__.'/vendor/autoload.php';\n")
  if (ddev) {
    mkdirSync(join(dir, '.ddev'))
    writeFileSync(join(dir, '.ddev', 'config.yaml'), 'name: demo\n')
  }
  return dir
}

for (const verb of /** @type {const} */ (['fmt', 'types', 'test'])) {
  test(`${verb}: ohne vendor scheitert der Schritt mit einem Hinweis auf composer install`, async (t) => {
    // Bisher entfielen pint und phpstan still, und ein PHP-Projekt ohne
    // artisan bestand das Gate mit null Prüfungen.
    const dir = uninstalled()
    t.after(() => rmSync(dir, { recursive: true, force: true }))

    const result = await runStep(runnable(laravel[verb]?.(context({ root: dir, dir }))), {
      quiet: true,
    })
    assert.equal(result.code, 1)
    assert.match(result.output, /vendor fehlt/)
    assert.match(result.output, /composer install/)
  })
}

test('tests: auch der PHP-Stack ohne artisan scheitert ohne vendor', async (t) => {
  const dir = uninstalled()
  rmSync(join(dir, 'artisan'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const result = await runStep(runnable(php.test?.(context({ root: dir, dir }))), { quiet: true })
  assert.equal(result.code, 1)
  assert.match(result.output, /vendor fehlt/)
})

test('pint: ohne vendor in einem ddev-Projekt nennt der Hinweis ddev composer install', async (t) => {
  // Projekte wie rankscan haben kein PHP auf dem Host; composer läuft dort im Container.
  const dir = uninstalled({ ddev: true })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const result = await runStep(runnable(laravel.fmt?.(context({ root: dir, dir }))), {
    quiet: true,
  })
  assert.match(result.output, /ddev composer install/)
})

test('phpstan: vendor der Repo-Wurzel genügt einer Unterkomponente', (t) => {
  fakeHost(t, { status: 'running' })
  const root = uninstalled()
  t.after(() => rmSync(root, { recursive: true, force: true }))
  mkdirSync(join(root, 'vendor', 'laravel', 'framework'), { recursive: true })
  mkdirSync(join(root, 'vendor', 'bin'), { recursive: true })
  writeFileSync(join(root, 'vendor', 'bin', 'phpstan'), '')
  const dir = join(root, 'api')
  mkdirSync(dir)
  writeFileSync(
    join(dir, 'composer.json'),
    JSON.stringify({ require: { 'laravel/framework': '^11' } }),
  )
  writeFileSync(join(dir, 'phpstan.neon'), '')

  const step = runnable(laravel.types?.(context({ root, dir })))
  assert.notEqual(step.cmd, process.execPath)
})

test('phpstan: mit vendor, aber ohne phpstan, entfällt der Schritt weiterhin', (t) => {
  // Fehlt nur ein Werkzeug, nutzt das Projekt es nicht. Das bleibt ein Skip.
  const dir = uninstalled()
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'vendor', 'laravel', 'framework'), { recursive: true })

  assert.ok(laravel.types?.(context({ root: dir, dir }))?.skip)
})

test('pint: ein composer.json nur mit Plattform-Anforderungen braucht kein vendor', (t) => {
  // php und ext-* installiert composer nie nach vendor.
  const dir = uninstalled({ require: { php: '^8.3', 'ext-json': '*' } })
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  assert.ok(laravel.fmt?.(context({ root: dir, dir }))?.skip)
})

test('tests: ein eigener Testbefehl läuft auch ohne vendor unverändert', (t) => {
  // Der Befehl aus quality.yml gehört dem Projekt, wie bei den JS-Stacks.
  fakeHost(t, { status: 'stopped', php: true })
  const dir = uninstalled()
  t.after(() => rmSync(dir, { recursive: true, force: true }))

  const ctx = context({ root: dir, dir })
  ctx.component.testCommand = 'php artisan test'
  const step = runnable(laravel.test?.(ctx))
  assert.equal(step.cmd, 'php')
})
