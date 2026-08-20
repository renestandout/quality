import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { LINT_STRICT_FLAG, findBinary, lintStrictArgs, missingToolHint, packageManagerFrom, scriptCommand } from './tools.mjs'

test('Paketmanager: das Feld packageManager schlägt das Lockfile', () => {
  // Gemessen an resplan: package.json nennt "pnpm@9.12.0". Corepack liest
  // genau dieses Feld — es nennt die Absicht, das Lockfile nur die Folge.
  assert.equal(packageManagerFrom({ declared: 'pnpm@9.12.0' }), 'pnpm')
  assert.equal(packageManagerFrom({ declared: 'pnpm@9.12.0', lockfiles: ['package-lock.json'] }), 'pnpm')
  assert.equal(packageManagerFrom({ declared: 'yarn@4.1.0' }), 'yarn')
})

test('Paketmanager: unbekannte Angaben zählen nicht als Entscheidung', () => {
  assert.equal(packageManagerFrom({ declared: 'bun@1.1.0' }), null)
  assert.equal(packageManagerFrom({ declared: '' }), null)
  assert.equal(packageManagerFrom({ declared: null, lockfiles: ['pnpm-lock.yaml'] }), 'pnpm')
})

test('Paketmanager: ohne jedes Signal entscheidet nichts', () => {
  // null und nicht "npm": "nichts entschied" ist eine andere Aussage, und
  // jeder Aufrufer setzt seinen eigenen Standard. jsAuditCommand macht daraus
  // "kein Lockfile", der Stack-Adapter macht daraus npm.
  assert.equal(packageManagerFrom(), null)
  assert.equal(packageManagerFrom({}), null)
})

test('Paketmanager: npm gewinnt, wenn zwei Lockfiles nebeneinander liegen', () => {
  assert.equal(packageManagerFrom({ lockfiles: ['pnpm-lock.yaml', 'package-lock.json'] }), 'npm')
  assert.equal(packageManagerFrom({ lockfiles: ['package-lock.json', 'pnpm-lock.yaml'] }), 'npm')
  assert.equal(packageManagerFrom({ lockfiles: ['npm-shrinkwrap.json'] }), 'npm')
  assert.equal(packageManagerFrom({ lockfiles: ['yarn.lock'] }), 'yarn')
})

test('Skript-Aufruf: npm braucht das "--", pnpm darf es nicht bekommen', () => {
  // Gemessen am 20.08.2026, npm 11.12.1 und pnpm 9.12, an resplans lint-Skript:
  //   npm  run --silent lint --version     -> npm meldet 11.12.1 (SEINE Version)
  //   npm  run --silent lint -- --version  -> eslint meldet v9.39.4
  //   pnpm run --silent lint --version     -> eslint meldet v9.39.4
  //   pnpm run --silent lint -- --version  -> eslint bekommt "--" als Dateimuster
  assert.deepEqual(scriptCommand('npm', 'lint', ['--max-warnings=0']), {
    cmd: 'npm',
    args: ['run', '--silent', 'lint', '--', '--max-warnings=0'],
  })
  assert.deepEqual(scriptCommand('pnpm', 'lint', ['--max-warnings=0']), {
    cmd: 'pnpm',
    args: ['run', '--silent', 'lint', '--max-warnings=0'],
  })
})

test('Skript-Aufruf: ohne Zusatzargumente steht nirgends ein "--"', () => {
  assert.deepEqual(scriptCommand('npm', 'build'), { cmd: 'npm', args: ['run', '--silent', 'build'] })
  assert.deepEqual(scriptCommand('pnpm', 'build'), { cmd: 'pnpm', args: ['run', '--silent', 'build'] })
})

test('Skript-Aufruf: yarn bekommt kein --silent', () => {
  // yarn berry kennt die Option nicht. Kein Standout-Projekt nutzt yarn —
  // dieser Zweig ist ungetestet in der Praxis und deshalb bewusst schmal.
  assert.deepEqual(scriptCommand('yarn', 'lint', ['--max-warnings=0']), {
    cmd: 'yarn',
    args: ['run', 'lint', '--max-warnings=0'],
  })
})

test('Skript-Aufruf: ein unbekannter Paketmanager fällt auf npm zurück', () => {
  assert.equal(scriptCommand(null, 'lint').cmd, 'npm')
  assert.equal(scriptCommand('bun', 'lint').cmd, 'npm')
})

test('Linter-Schärfe: die bekannten Linter werden erkannt', () => {
  assert.deepEqual(lintStrictArgs('eslint .'), [LINT_STRICT_FLAG.eslint])
  assert.deepEqual(lintStrictArgs('oxlint'), [LINT_STRICT_FLAG.oxlint])
  assert.deepEqual(lintStrictArgs('oxlint --type-aware src'), [LINT_STRICT_FLAG.oxlint])
  // "next lint" reicht eslint-Optionen durch, enthält aber nicht "eslint".
  assert.deepEqual(lintStrictArgs('next lint'), [LINT_STRICT_FLAG.eslint])
  assert.deepEqual(lintStrictArgs('./node_modules/.bin/eslint src'), [LINT_STRICT_FLAG.eslint])
})

test('Linter-Schärfe: verkettete Skripte bleiben unangetastet', () => {
  // Ein weitergereichtes Argument landet nur beim LETZTEN Befehl der Kette.
  // Halb scharf ist schlechter als offen nicht scharf: es erzeugt dasselbe
  // gruene Haekchen, sagt aber weniger.
  assert.equal(lintStrictArgs('eslint . && stylelint "**/*.css"'), null)
  assert.equal(lintStrictArgs('eslint .; prettier --check .'), null)
  assert.equal(lintStrictArgs('eslint --format json . | tee lint.json'), null)
})

test('Linter-Schärfe: unbekannte Skripte melden null statt zu raten', () => {
  assert.equal(lintStrictArgs('biome check .'), null)
  assert.equal(lintStrictArgs('tsc --noEmit'), null)
  assert.equal(lintStrictArgs(''), null)
  assert.equal(lintStrictArgs(undefined), null)
})

test('Werkzeugsuche: jeder Stack hat sein eigenes Installationsverzeichnis', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-bin-'))
  try {
    for (const [rel, name] of [
      ['vendor/bin', 'pint'],
      ['node_modules/.bin', 'prettier'],
      ['.venv/bin', 'ruff'],
    ]) {
      mkdirSync(join(root, rel), { recursive: true })
      writeFileSync(join(root, rel, name), '')
    }
    assert.equal(findBinary('pint', { dir: root, kind: 'php' }), join(root, 'vendor/bin/pint'))
    assert.equal(findBinary('prettier', { dir: root, kind: 'js' }), join(root, 'node_modules/.bin/prettier'))
    assert.equal(findBinary('ruff', { dir: root, kind: 'py' }), join(root, '.venv/bin/ruff'))
    // Kein Stack sieht die Werkzeuge eines anderen.
    assert.equal(findBinary('pint', { dir: root, kind: 'py' }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Werkzeugsuche: die Komponente schlaegt die Repo-Wurzel', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-bin-order-'))
  try {
    const dir = join(root, 'tools', 'analyse')
    for (const base of [root, dir]) {
      mkdirSync(join(base, '.venv', 'bin'), { recursive: true })
      writeFileSync(join(base, '.venv', 'bin', 'mypy'), '')
    }
    assert.equal(findBinary('mypy', { dir, root, kind: 'py' }), join(dir, '.venv/bin/mypy'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Werkzeugsuche: nur Python weicht auf den PATH aus', () => {
  // ruff und mypy werden regelmaessig global installiert (pipx, Homebrew).
  // Bei PHP und JS waere ein globales Werkzeug die falsche Version — dort
  // bleibt es beim Projektpfad und der Schritt meldet, was fehlt.
  const root = mkdtempSync(join(tmpdir(), 'quality-bin-path-'))
  try {
    assert.equal(findBinary('node', { dir: root, kind: 'py' }), 'node')
    assert.equal(findBinary('node', { dir: root, kind: 'js' }), null)
    assert.equal(findBinary('node', { dir: root, kind: 'php' }), null)
    assert.equal(findBinary('gibt-es-nicht-4711', { dir: root, kind: 'py' }), null)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Der Installationshinweis nennt den Paketmanager des Stacks', () => {
  assert.match(missingToolHint('pint', 'php'), /composer require --dev laravel\/pint/)
  assert.match(missingToolHint('prettier', 'js'), /npm install -D prettier/)
  assert.match(missingToolHint('ruff', 'py'), /pip install ruff/)
})
