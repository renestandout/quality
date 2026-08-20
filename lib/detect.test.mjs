import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { detectComponents, factsFromManifests, pythonManifest, stackFromManifests } from './detect.mjs'

test('Laravel wird am Framework erkannt, nicht am Ordnernamen', () => {
  assert.equal(stackFromManifests({ composer: { require: { 'laravel/framework': '^13.0' } } }), 'laravel')
  assert.equal(stackFromManifests({ composer: { require: { 'symfony/console': '^7' } } }), 'php')
})

test('composer gewinnt gegen package.json im selben Ordner', () => {
  // Ein Laravel-Projekt hat fast immer beides; das package.json bündelt dort
  // nur Assets und ist keine eigene Komponente.
  const stack = stackFromManifests({
    composer: { require: { 'laravel/framework': '^13.0' } },
    pkg: { devDependencies: { vite: '^7' } },
  })
  assert.equal(stack, 'laravel')
})

test('JS-Stacks: next vor react vor node', () => {
  assert.equal(stackFromManifests({ pkg: { dependencies: { next: '^15', react: '^19' } } }), 'next-ts')
  assert.equal(stackFromManifests({ pkg: { dependencies: { react: '^19' } } }), 'react-ts')
  assert.equal(stackFromManifests({ pkg: { dependencies: { express: '^5' } } }), 'node-ts')
  assert.equal(stackFromManifests({}), null)
})

test('Fakten aus den Manifesten', () => {
  const facts = factsFromManifests({
    composer: { require: { php: '^8.3', 'laravel/framework': '^13.0' }, 'require-dev': { 'laravel/pint': '^1' } },
  })
  assert.equal(facts.php, '^8.3')
  assert.equal(facts.hasPint, true)
  assert.equal(facts.hasPhpstan, false)
})

test('config.platform.php schlägt den require-Constraint', () => {
  // Der Constraint ist eine Mindestangabe und hinkt hinterher: bei adboard
  // stand dort ^8.3, während die composer.lock faktisch 8.4.1 verlangte.
  const facts = factsFromManifests({
    composer: { require: { php: '^8.3' }, config: { platform: { php: '8.4.1' } } },
  })
  assert.equal(facts.php, '8.4.1')
  assert.equal(facts.phpFrom, 'platform')

  // Ohne platform bleibt der Constraint — aber als solcher gekennzeichnet,
  // damit der Bericht darauf hinweisen kann.
  const ohne = factsFromManifests({ composer: { require: { php: '^8.3' } } })
  assert.equal(ohne.phpFrom, 'constraint')
})

test('Monorepo: beide Komponenten werden gefunden, node_modules nicht', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-detect-'))
  try {
    mkdirSync(join(root, 'app', 'backend'), { recursive: true })
    mkdirSync(join(root, 'app', 'frontend', 'node_modules', 'foo'), { recursive: true })
    writeFileSync(
      join(root, 'app', 'backend', 'composer.json'),
      JSON.stringify({ require: { 'laravel/framework': '^13.0', php: '^8.3' } })
    )
    writeFileSync(
      join(root, 'app', 'frontend', 'package.json'),
      JSON.stringify({ dependencies: { react: '^19' } })
    )
    writeFileSync(join(root, 'app', 'frontend', 'node_modules', 'foo', 'package.json'), '{"name":"foo"}')

    const found = detectComponents(root).sort((a, b) => a.path.localeCompare(b.path))
    assert.deepEqual(
      found.map((f) => [f.path, f.stack]),
      [
        ['app/backend', 'laravel'],
        ['app/frontend', 'react-ts'],
      ]
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Eine Komponente wird nicht in ihre eigenen Unterordner zerlegt', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-detect-'))
  try {
    writeFileSync(join(root, 'composer.json'), JSON.stringify({ require: { 'laravel/framework': '^13.0' } }))
    mkdirSync(join(root, 'resources', 'js'), { recursive: true })
    writeFileSync(join(root, 'resources', 'js', 'package.json'), JSON.stringify({ dependencies: { react: '^19' } }))

    const found = detectComponents(root)
    assert.equal(found.length, 1)
    assert.equal(found[0].path, '.')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Python wird an einem seiner Manifeste erkannt', () => {
  assert.equal(stackFromManifests({ python: 'pyproject.toml' }), 'python')
  // agent-desk ist der reale Fall: gewachsenes Skript-Repo, kein
  // pyproject.toml, aber eine pytest.ini.
  assert.equal(stackFromManifests({ python: 'pytest.ini' }), 'python')
  assert.equal(stackFromManifests({}), null)
})

test('Python steht hinter composer und package.json', () => {
  // Eine pytest.ini neben einem package.json macht aus dem JS-Projekt keine
  // Python-Komponente — dort gehoeren die Tests zum JS-Werkzeug.
  assert.equal(stackFromManifests({ pkg: { dependencies: { react: '^19' } }, python: 'pytest.ini' }), 'react-ts')
  assert.equal(
    stackFromManifests({ composer: { require: { 'laravel/framework': '^13.0' } }, python: 'pytest.ini' }),
    'laravel'
  )
})

test('pythonManifest nennt die Datei, an der es haengt', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-py-'))
  try {
    assert.equal(pythonManifest(root), null)
    writeFileSync(join(root, 'pytest.ini'), '[pytest]\n')
    assert.equal(pythonManifest(root), 'pytest.ini')
    // pyproject.toml gilt als der staerkere Marker und steht deshalb vorn.
    writeFileSync(join(root, 'pyproject.toml'), '[project]\n')
    assert.equal(pythonManifest(root), 'pyproject.toml')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('detectComponents findet eine Python-Komponente und nennt ihr Manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'quality-detect-py-'))
  try {
    mkdirSync(join(root, 'tools', 'analyse'), { recursive: true })
    writeFileSync(join(root, 'tools', 'analyse', 'pyproject.toml'), '[project]\nname = "analyse"\n')
    const found = detectComponents(root)
    assert.deepEqual(
      found.map((c) => [c.path, c.stack]),
      [['tools/analyse', 'python']]
    )
    assert.equal(found[0].facts.pythonManifest, 'pyproject.toml')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('ein .venv wird nicht als eigene Komponente gelesen', () => {
  // Sonst pruefte das Gate die installierten Fremdpakete mit.
  const root = mkdtempSync(join(tmpdir(), 'quality-venv-'))
  try {
    writeFileSync(join(root, 'pytest.ini'), '[pytest]\n')
    mkdirSync(join(root, '.venv', 'lib'), { recursive: true })
    writeFileSync(join(root, '.venv', 'pyproject.toml'), '[project]\n')
    assert.deepEqual(
      detectComponents(root).map((c) => c.path),
      ['.']
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
