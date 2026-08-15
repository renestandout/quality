import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { PHP_ANALYSE_PATHS } from './detect.mjs'
import { applyInit, phpVersionId, phpstanIncludePath, renderPhpstanNeon } from './init.mjs'

const PKG_ROOT = join(import.meta.dirname, '..')

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'quality-init-'))
  mkdirSync(join(root, 'backend', 'app'), { recursive: true })
  mkdirSync(join(root, 'backend', 'routes'), { recursive: true })
  mkdirSync(join(root, 'frontend'), { recursive: true })
  return root
}

const RECOMMENDATION = {
  level: 'strict',
  components: [
    { path: 'backend', stack: 'laravel', php: '8.3', phpstanLevel: 5, baseline: true },
    { path: 'frontend', stack: 'react-ts', baseline: false },
  ],
}

test('Messung und erzeugte Konfiguration analysieren dasselbe', () => {
  // Zwei Listen bedeuten, dass der Audit einen anderen Umfang misst als der
  // Betrieb prüft — die Zahl im Bericht wäre dann systematisch falsch.
  // Aufgefallen beim adboard-Rollout: config/ war nur in der Messung dabei.
  const audit = readFileSync(join(PKG_ROOT, 'lib', 'audit-run.mjs'), 'utf8')
  const init = readFileSync(join(PKG_ROOT, 'lib', 'init.mjs'), 'utf8')
  for (const [name, source] of [
    ['audit-run.mjs', audit],
    ['init.mjs', init],
  ]) {
    assert.match(source, /const PHP_PATHS = PHP_ANALYSE_PATHS/, `${name} führt eine eigene Pfadliste`)
  }
  assert.ok(PHP_ANALYSE_PATHS.includes('app'))
  assert.ok(!PHP_ANALYSE_PATHS.includes('config'), 'config/ enthält erlaubte env()-Aufrufe')
})

test('PHP-Version wird in PHPStans Zahlenformat übersetzt', () => {
  assert.equal(phpVersionId('8.3'), 80300)
  assert.equal(phpVersionId('^8.2'), 80200)
  assert.equal(phpVersionId(null), null)
})

test('Include zeigt auf vendor, wenn das Paket ausserhalb des Repos liegt', () => {
  const root = fixture()
  try {
    // PKG_ROOT liegt hier nicht im Testrepo — dann gilt der Pfad, der nach
    // "composer require" stimmt, und der Aufrufer muss darauf hinweisen.
    const include = phpstanIncludePath(join(root, 'backend'), PKG_ROOT, root)
    assert.equal(include.installed, false)
    assert.equal(include.path, 'vendor/standout/quality/configs/phpstan/base.neon')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('phpstan.neon enthält nur vorhandene Verzeichnisse', () => {
  const neon = renderPhpstanNeon({
    include: 'vendor/standout/quality/configs/phpstan/base.neon',
    larastan: 'vendor/larastan/larastan/extension.neon',
    phpVersionId: 80300,
    paths: ['app', 'routes'],
  })
  // Larastan steht vor der Basiskonfiguration, damit deren Parameter gelten.
  assert.ok(neon.indexOf('larastan') < neon.indexOf('base.neon'))
  assert.match(neon, /- app/)
  assert.match(neon, /- routes/)
  assert.doesNotMatch(neon, /- database/)
  assert.match(neon, /phpVersion: 80300/)
  // Die Baseline steht auskommentiert drin: eingebunden, bevor sie existiert,
  // liesse sie PHPStan scheitern.
  assert.match(neon, /# - phpstan-baseline\.neon/)
})

test('init schreibt quality.yml und phpstan.neon, aber nicht fürs Frontend', () => {
  const root = fixture()
  try {
    const result = applyInit(root, RECOMMENDATION, { pkgRoot: PKG_ROOT })
    const files = result.written.map((w) => w.file).sort()
    assert.deepEqual(files, ['backend/phpstan.neon', 'quality.yml'])
    assert.match(readFileSync(join(root, 'quality.yml'), 'utf8'), /level: strict/)
    assert.ok(existsSync(join(root, 'backend', 'phpstan.neon')))
    // Larastan fehlt im Testrepo — darauf muss init hinweisen, sonst meldet
    // PHPStan später Eloquent-Fehler, die keine sind.
    assert.ok(result.notes.some((n) => /Larastan/.test(n)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('init überschreibt nichts von sich aus', () => {
  const root = fixture()
  try {
    writeFileSync(join(root, 'quality.yml'), 'version: 1\n# von Hand gepflegt\n')
    const result = applyInit(root, RECOMMENDATION, { pkgRoot: PKG_ROOT })
    assert.ok(result.skipped.some((s) => s.file === 'quality.yml'))
    assert.match(readFileSync(join(root, 'quality.yml'), 'utf8'), /von Hand gepflegt/)

    const forced = applyInit(root, RECOMMENDATION, { pkgRoot: PKG_ROOT, force: true })
    assert.ok(forced.written.some((w) => w.file === 'quality.yml'))
    assert.doesNotMatch(readFileSync(join(root, 'quality.yml'), 'utf8'), /von Hand gepflegt/)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('--dry-run schreibt nichts', () => {
  const root = fixture()
  try {
    const result = applyInit(root, RECOMMENDATION, { pkgRoot: PKG_ROOT, dryRun: true })
    assert.equal(result.written.length, 2)
    assert.equal(existsSync(join(root, 'quality.yml')), false)
    assert.equal(existsSync(join(root, 'backend', 'phpstan.neon')), false)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Komponente ohne analysierbares Verzeichnis wird übersprungen, nicht erfunden', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-init-'))
  try {
    mkdirSync(join(root, 'lib-only'), { recursive: true })
    const result = applyInit(
      root,
      { level: 'standard', components: [{ path: 'lib-only', stack: 'php', phpstanLevel: 5, baseline: false }] },
      { pkgRoot: PKG_ROOT }
    )
    assert.ok(result.skipped.some((s) => /kein analysierbares Verzeichnis/.test(s.reason)))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
