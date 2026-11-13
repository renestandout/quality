/**
 * `scripts/release.mjs` — Versions-Commit nur auf grünem main.
 *
 * Der Anlass: Am 13.11.2026 lag der Release-Commit 0.2.29 auf einem main mit
 * roter CI. Das Claude-Code-Plugin holt main, sobald die Version steigt. Ein
 * roter Release-Commit geht so direkt in die Hooks aller Konten.
 *
 * Die Tests laufen in einem echten Git-Repo mit einem lokalen Remote. Die
 * Dateien sind Kopien der echten Versionsdateien. Nur die Frage an GitHub ist
 * eine Attrappe: Gefragt ist, wie das Skript die Antwort von deploy-check wertet.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { VERSION_FILES, bumpVersionFiles, runRelease } from './release.mjs'

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..')
const CURRENT = JSON.parse(readFileSync(join(REPO, 'package.json'), 'utf8')).version

/**
 * @param {string} cwd
 * @param {string[]} args
 */
const git = (cwd, args) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * Ein Klon mit Remote `origin`. main enthält die fünf Versionsdateien und ist
 * gepusht. HEAD steht also auf origin/main.
 */
function fixture() {
  const base = mkdtempSync(join(tmpdir(), 'quality-release-'))
  const origin = join(base, 'origin.git')
  const work = join(base, 'work')
  execFileSync('git', ['init', '--bare', '--initial-branch=main', origin], { stdio: 'ignore' })
  execFileSync('git', ['clone', origin, work], { stdio: 'ignore' })
  git(work, ['config', 'user.email', 'test@example.invalid'])
  git(work, ['config', 'user.name', 'Test'])
  git(work, ['config', 'commit.gpgsign', 'false'])
  git(work, ['checkout', '-b', 'main'])
  for (const file of VERSION_FILES) {
    mkdirSync(dirname(join(work, file)), { recursive: true })
    copyFileSync(join(REPO, file), join(work, file))
  }
  git(work, ['add', '.'])
  git(work, ['commit', '-m', 'Ausgangsstand'])
  git(work, ['push', 'origin', 'main'])
  return { base, work, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

/** @param {string} work */
const snapshot = (work) =>
  Object.fromEntries(VERSION_FILES.map((f) => [f, readFileSync(join(work, f), 'utf8')]))

/**
 * Attrappe für deploy-check. Sie merkt sich die Aufrufe und schreibt die eine
 * Zeile auf stdout wie das echte Kommando.
 *
 * @param {number} code
 * @param {string} line
 */
function fakeDeployCheck(code, line) {
  /** @type {{ ref: string | null | undefined, env: Record<string, string | undefined> | undefined }[]} */
  const calls = []
  /** @param {import('./deploy-check.mjs').DeployCheckOptions} options */
  const check = async (options) => {
    calls.push({ ref: options.ref, env: options.env })
    options.write?.out(`${line}\n`)
    return code
  }
  return { check, calls }
}

const silent = { out: () => {}, err: () => {} }

/** Hebt die Patch-Stelle um eins. */
function next() {
  const [major, minor, patch] = CURRENT.split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

test('release: roter Stand bricht ab und ändert keine Datei', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  const before = snapshot(work)
  const head = git(work, ['rev-parse', 'HEAD'])
  const gate = fakeDeployCheck(1, `deploy-check: blockiert ${head} — rot: quality`)

  const code = await runRelease({
    root: work,
    version: next(),
    deployCheck: gate.check,
    env: {},
    write: silent,
  })

  assert.equal(code, 1)
  assert.equal(gate.calls.length, 1)
  assert.deepEqual(snapshot(work), before)
  assert.equal(git(work, ['rev-parse', 'HEAD']), head)
  assert.equal(git(work, ['status', '--porcelain']), '')
})

test('release: keine Aussage von deploy-check (Exit 2) bricht ebenfalls ab', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  const before = snapshot(work)
  const gate = fakeDeployCheck(2, 'deploy-check: blockiert x — keine Aussage möglich')

  const code = await runRelease({
    root: work,
    version: next(),
    deployCheck: gate.check,
    env: {},
    write: silent,
  })

  assert.equal(code, 1)
  assert.deepEqual(snapshot(work), before)
})

test('release: grüner Stand hebt alle fünf Dateien und committet', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  const head = git(work, ['rev-parse', 'HEAD'])
  const line = `deploy-check: grün ${head} quality`
  const gate = fakeDeployCheck(0, line)
  const version = next()

  const code = await runRelease({
    root: work,
    version,
    deployCheck: gate.check,
    env: {},
    write: silent,
  })

  assert.equal(code, 0)
  assert.equal(gate.calls[0]?.ref, head)
  assert.equal(git(work, ['rev-parse', 'HEAD~1']), head)
  assert.deepEqual(
    git(work, ['diff', '--name-only', 'HEAD~1', 'HEAD']).split('\n').sort(),
    [...VERSION_FILES].sort(),
  )
  const message = git(work, ['log', '-1', '--format=%B'])
  assert.match(message, new RegExp(`^build: Version ${version.replaceAll('.', '\\.')}\n`))
  assert.ok(message.includes(line), 'die Zeile von deploy-check steht in der Commit-Message')
  assert.equal(git(work, ['status', '--porcelain']), '')
  assert.equal(git(work, ['tag']), '', 'das Skript setzt keinen Tag')
  assert.equal(git(work, ['rev-parse', 'origin/main']), head, 'das Skript pusht nicht')
  // Gesucht wird die Version in der Form, in der sie gepflegt wird. Die README
  // nennt alte Versionen auch im Fliesstext, etwa 0.2.29 als Anlass.
  for (const file of VERSION_FILES) {
    const text = readFileSync(join(work, file), 'utf8')
    const [oldForm, newForm] =
      file === 'README.md'
        ? [`quality#v${CURRENT}`, `quality#v${version}`]
        : [`"version": "${CURRENT}"`, `"version": "${version}"`]
    assert.ok(!text.includes(oldForm), `${file} enthält die alte Version nicht mehr`)
    assert.ok(text.includes(newForm), `${file} enthält die neue Version`)
  }
})

test('release: scheitert der Commit, nimmt das Skript die Dateien zurück', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  writeFileSync(join(work, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })
  const before = snapshot(work)
  const head = git(work, ['rev-parse', 'HEAD'])
  const gate = fakeDeployCheck(0, `deploy-check: grün ${head} quality`)

  const code = await runRelease({
    root: work,
    version: next(),
    deployCheck: gate.check,
    env: {},
    write: silent,
  })

  assert.equal(code, 1)
  assert.deepEqual(snapshot(work), before)
  assert.equal(git(work, ['rev-parse', 'HEAD']), head)
  assert.equal(git(work, ['status', '--porcelain']), '')
})

test('release: ein anderer Branch als main bricht ab, auch auf derselben SHA', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  const gate = fakeDeployCheck(0, 'deploy-check: grün x quality')

  for (const checkout of [
    ['checkout', '-b', 'feature'],
    ['checkout', '--detach'],
  ]) {
    git(work, checkout)
    const before = snapshot(work)
    const code = await runRelease({
      root: work,
      version: next(),
      deployCheck: gate.check,
      env: {},
      write: silent,
    })
    assert.equal(code, 1, checkout.join(' '))
    assert.deepEqual(snapshot(work), before)
  }
  assert.equal(gate.calls.length, 0)
})

test('release: ohne origin/main endet das Skript mit Exit 1 statt mit einem Absturz', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  git(work, ['remote', 'remove', 'origin'])
  const gate = fakeDeployCheck(0, 'deploy-check: grün x quality')

  const code = await runRelease({
    root: work,
    version: next(),
    deployCheck: gate.check,
    env: {},
    write: silent,
  })

  assert.equal(code, 1)
  assert.equal(gate.calls.length, 0)
})

test('release: Override wird an deploy-check durchgereicht und steht im Commit', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  const head = git(work, ['rev-parse', 'HEAD'])
  const line = `deploy-check: override ${head} — Runner ausgefallen`
  const gate = fakeDeployCheck(0, line)
  const env = { QUALITY_DEPLOY_OVERRIDE: 'Runner ausgefallen' }

  const code = await runRelease({
    root: work,
    version: next(),
    deployCheck: gate.check,
    env,
    write: silent,
  })

  assert.equal(code, 0)
  assert.equal(gate.calls[0]?.env, env)
  assert.ok(git(work, ['log', '-1', '--format=%B']).includes(line))
})

test('release: HEAD ungleich origin/main bricht ab, bevor deploy-check fragt', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  writeFileSync(join(work, 'neu.txt'), 'x\n')
  git(work, ['add', 'neu.txt'])
  git(work, ['commit', '-m', 'ungepusht'])
  const before = snapshot(work)
  const gate = fakeDeployCheck(0, 'deploy-check: grün x quality')

  const code = await runRelease({
    root: work,
    version: next(),
    deployCheck: gate.check,
    env: {},
    write: silent,
  })

  assert.equal(code, 1)
  assert.equal(gate.calls.length, 0)
  assert.deepEqual(snapshot(work), before)
})

test('release: Änderungen im Arbeitsverzeichnis brechen ab', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  writeFileSync(join(work, 'offen.txt'), 'x\n')
  const before = snapshot(work)
  const gate = fakeDeployCheck(0, 'deploy-check: grün x quality')

  const code = await runRelease({
    root: work,
    version: next(),
    deployCheck: gate.check,
    env: {},
    write: silent,
  })

  assert.equal(code, 1)
  assert.equal(gate.calls.length, 0)
  assert.deepEqual(snapshot(work), before)
})

test('release: Version nicht höher als die aktuelle bricht ab', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  const before = snapshot(work)
  const gate = fakeDeployCheck(0, 'deploy-check: grün x quality')

  const code = await runRelease({
    root: work,
    version: CURRENT,
    deployCheck: gate.check,
    env: {},
    write: silent,
  })

  assert.equal(code, 1)
  assert.equal(gate.calls.length, 0)
  assert.deepEqual(snapshot(work), before)
})

test('release: ungültige Versionsangabe endet mit Exit 2', async (t) => {
  const { work, cleanup } = fixture()
  t.after(cleanup)
  const gate = fakeDeployCheck(0, 'deploy-check: grün x quality')

  for (const version of ['', 'v1.2.3', '1.2', '1.2.3-rc1', 'abc']) {
    const code = await runRelease({
      root: work,
      version,
      deployCheck: gate.check,
      env: {},
      write: silent,
    })
    assert.equal(code, 2, `"${version}"`)
  }
  assert.equal(gate.calls.length, 0)
})

test('bumpVersionFiles: ändert in den echten Dateien nur die Versionsfelder', () => {
  const files = Object.fromEntries(
    VERSION_FILES.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]),
  )
  const bumped = bumpVersionFiles(files, CURRENT, '9.9.9')

  const pkg = JSON.parse(bumped['package.json'] ?? '')
  assert.equal(pkg.version, '9.9.9')
  assert.deepEqual({ ...pkg, version: CURRENT }, JSON.parse(files['package.json'] ?? ''))

  const lock = JSON.parse(bumped['package-lock.json'] ?? '')
  assert.equal(lock.version, '9.9.9')
  assert.equal(lock.packages[''].version, '9.9.9')
  lock.version = CURRENT
  lock.packages[''].version = CURRENT
  assert.deepEqual(lock, JSON.parse(files['package-lock.json'] ?? ''))

  const plugin = JSON.parse(bumped['.claude-plugin/plugin.json'] ?? '')
  assert.equal(plugin.version, '9.9.9')

  const market = JSON.parse(bumped['.claude-plugin/marketplace.json'] ?? '')
  assert.equal(market.plugins[0].version, '9.9.9')

  const readme = bumped['README.md'] ?? ''
  assert.ok(readme.includes('quality#v9.9.9'))
  assert.ok(!readme.includes(`quality#v${CURRENT}`))
  assert.equal(readme.replaceAll('quality#v9.9.9', `quality#v${CURRENT}`), files['README.md'])
})

test('bumpVersionFiles: fehlt die alte Version in einer Datei, wirft es', () => {
  const files = Object.fromEntries(
    VERSION_FILES.map((f) => [f, readFileSync(join(REPO, f), 'utf8')]),
  )
  files['README.md'] = 'kein Pin\n'
  assert.throws(() => bumpVersionFiles(files, CURRENT, '9.9.9'), /README\.md/)
})
