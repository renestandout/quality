import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { filesInScope } from './phpstan-scope.mjs'

const CHANGED = ['app/A.php', 'app/Legacy/L.php', 'tests/T.php', 'routes/web.php']

/**
 * Eine Komponente mit den angegebenen Dateien.
 *
 * @param {import('node:test').TestContext} t
 * @param {Record<string, string>} files Pfad relativ zur Komponente → Inhalt
 * @returns {string}
 */
function component(t, files) {
  const dir = mkdtempSync(join(tmpdir(), 'quality-scope-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  // Die geänderten Dateien liegen wie im echten Projekt auf der Platte.
  for (const path of [...CHANGED, 'application/X.php']) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), '<?php\n')
  }
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(join(dir, path, '..'), { recursive: true })
    writeFileSync(join(dir, path), content)
  }
  return dir
}

test('paths filtern: nur Dateien in den paths bleiben', (t) => {
  const dir = component(t, {
    'phpstan.neon': 'parameters:\n    paths:\n        - app\n        - routes/web.php\n',
  })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), [
    'app/A.php',
    'app/Legacy/L.php',
    'routes/web.php',
  ])
})

test('paths als Inline-Liste mit Anführungszeichen', (t) => {
  const dir = component(t, { 'phpstan.neon': 'parameters:\n    paths: [app, "routes"]\n' })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), [
    'app/A.php',
    'app/Legacy/L.php',
    'routes/web.php',
  ])
})

test('ein Ordnername als Präfix zählt nicht: app deckt application/ nicht ab', (t) => {
  const dir = component(t, { 'phpstan.neon': 'parameters:\n    paths:\n        - app\n' })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', ['application/X.php']), [])
})

test('paths aus einer eingebundenen Datei gelten, relativ zu ihrem Ordner', (t) => {
  const dir = component(t, {
    'phpstan.neon': 'includes:\n    - config/phpstan/paths.neon\n',
    'config/phpstan/paths.neon': 'parameters:\n    paths:\n        - ../../app\n',
  })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), ['app/A.php', 'app/Legacy/L.php'])
})

test('excludePaths: Ordner, Muster und beide Formen (Liste, analyse/analyseAndScan)', (t) => {
  const dir = component(t, {
    'phpstan.neon': [
      'includes:',
      '    - base.neon',
      'parameters:',
      '    paths:',
      '        - app',
      '        - routes',
      '    excludePaths:',
      '        analyse:',
      '            - app/Legacy',
      '',
    ].join('\n'),
    // So bindet quality die Paket-Basis ein: Muster mit führendem *.
    'base.neon':
      'parameters:\n    excludePaths:\n        analyseAndScan:\n            - */routes/*\n',
  })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), ['app/A.php'])
})

test('excludePaths als flache Liste, mit (?) für optionale Einträge', (t) => {
  const dir = component(t, {
    'phpstan.neon':
      'parameters:\n    paths:\n        - app\n    excludePaths:\n        - app/Legacy (?)\n',
  })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), ['app/A.php'])
})

test('Larastan-artige Includes mit services stören das Lesen nicht', (t) => {
  const dir = component(t, {
    'phpstan.neon': 'includes:\n    - ext.neon\nparameters:\n    paths:\n        - app\n',
    'ext.neon': [
      'parameters:',
      '    universalObjectCratesClasses:',
      '        - Illuminate\\Http\\Request',
      'services:',
      '    -',
      '        class: Foo\\Bar',
      '        tags: [phpstan.broker.dynamicMethodReturnTypeExtension]',
      '        arguments: { a: @x::y(), b: %rootDir% }',
      '',
    ].join('\n'),
  })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), ['app/A.php', 'app/Legacy/L.php'])
})

test('mit Tabs eingerückt wie die Baseline, die PHPStan selbst schreibt', (t) => {
  const dir = component(t, {
    'phpstan.neon': 'includes:\n    - phpstan-baseline.neon\nparameters:\n\tpaths:\n\t\t- app\n',
    'phpstan-baseline.neon': [
      'parameters:',
      '\tignoreErrors:',
      '\t\t-',
      '\t\t\tmessage: \'#^Comparison operation "\\<" between 10\\|12 and 0 is always false\\.$#\'',
      '\t\t\tcount: 1',
      '\t\t\tpath: tests/T.php',
      '',
    ].join('\n'),
  })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), ['app/A.php', 'app/Legacy/L.php'])
})

test('eine Liste auf der Einrückung ihres Schlüssels gehört zum Schlüssel', (t) => {
  const dir = component(t, {
    'phpstan.neon': 'parameters:\n    paths:\n    - app\n    excludePaths:\n    - app/Legacy\n',
  })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), ['app/A.php'])
})

test('absolute geänderte Dateien werden wie relative eingeordnet', (t) => {
  const dir = component(t, { 'phpstan.neon': 'parameters:\n    paths:\n        - app\n' })
  assert.deepEqual(
    filesInScope(dir, 'phpstan.neon', [join(dir, 'app/A.php'), join(dir, 'tests/T.php')]),
    [join(dir, 'app/A.php')],
  )
})

test('ein maskiertes Anführungszeichen beendet die Zeichenkette nicht', (t) => {
  const dir = component(t, {
    'phpstan.neon':
      'parameters:\n    paths:\n        - "app" # Kommentar\n    excludePaths:\n        - "app/\\"x #y"\n',
  })
  assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), ['app/A.php', 'app/Legacy/L.php'])
})

/*
 * Kann quality die Konfiguration nicht sicher lesen, filtert es nicht. Dann
 * prüft PHPStan alle geänderten Dateien wie bisher: das Gate bleibt hart.
 */
for (const [name, files] of /** @type {[string, Record<string, string>][]} */ ([
  ['keine paths', { 'phpstan.neon': 'parameters:\n    level: 5\n' }],
  [
    'Platzhalter in paths',
    { 'phpstan.neon': 'parameters:\n    paths:\n        - %rootDir%/app\n' },
  ],
  ['Muster in paths', { 'phpstan.neon': 'parameters:\n    paths:\n        - src/*/app\n' }],
  [
    'fehlendes Include',
    { 'phpstan.neon': 'includes:\n    - fehlt.neon\nparameters:\n    paths:\n        - app\n' },
  ],
  [
    'Include mit Platzhalter',
    {
      'phpstan.neon': 'includes:\n    - %rootDir%/x.neon\nparameters:\n    paths:\n        - app\n',
    },
  ],
  [
    'paths mit Überschreib-Markierung',
    { 'phpstan.neon': 'parameters:\n    paths!:\n        - app\n' },
  ],
  ['Tabs und Leerzeichen gemischt', { 'phpstan.neon': 'parameters:\n\t    paths:\n\t\t- app\n' }],
  ['fehlende Konfiguration', {}],
  // ddev: ein Pfad im Container existiert auf dem Host nicht.
  [
    'absoluter Pfad, der fehlt',
    { 'phpstan.neon': 'parameters:\n    paths:\n        - /var/www/html/app\n' },
  ],
  [
    'unbekannter Schlüssel in excludePaths',
    {
      'phpstan.neon':
        'parameters:\n    paths:\n        - app\n    excludePaths:\n        analyze:\n            - app/Legacy\n',
    },
  ],
  [
    'excludePaths als Skalar',
    { 'phpstan.neon': 'parameters:\n    paths:\n        - app\n    excludePaths: app/Legacy\n' },
  ],
  [
    'mehrzeilige Zeichenkette',
    {
      'phpstan.neon':
        "parameters:\n    paths:\n        - app\n    x: '''\n    paths:\n        - tests\n    '''\n",
    },
  ],
])) {
  test(`unsicher (${name}): alle Dateien bleiben`, (t) => {
    const dir = component(t, files)
    assert.deepEqual(filesInScope(dir, 'phpstan.neon', CHANGED), CHANGED)
  })
}
