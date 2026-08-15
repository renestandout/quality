import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseYaml, YamlError } from './yaml.mjs'

test('flache Map mit Skalartypen', () => {
  assert.deepEqual(parseYaml('version: 1\nlevel: standard\nbaseline: true\nleer: null'), {
    version: 1,
    level: 'standard',
    baseline: true,
    leer: null,
  })
})

test('Kommentare und Leerzeilen werden ignoriert', () => {
  const y = `# Kopfkommentar
version: 1   # nachgestellt

level: strict
`
  assert.deepEqual(parseYaml(y), { version: 1, level: 'strict' })
})

test('Raute in Anführungszeichen ist kein Kommentar', () => {
  assert.deepEqual(parseYaml('farbe: "#ff0000"'), { farbe: '#ff0000' })
})

test('Sequenz aus Block-Maps', () => {
  const y = `components:
  - path: ads-cockpit/backend
    stack: laravel
    php: "8.3"
    phpstan_level: 5
  - path: ads-cockpit/frontend
    stack: react-ts
`
  assert.deepEqual(parseYaml(y), {
    components: [
      { path: 'ads-cockpit/backend', stack: 'laravel', php: '8.3', phpstan_level: 5 },
      { path: 'ads-cockpit/frontend', stack: 'react-ts' },
    ],
  })
})

test('Sequenz mit Inline-Maps', () => {
  const y = `components:
  - { path: ".", stack: next-ts }
`
  assert.deepEqual(parseYaml(y), { components: [{ path: '.', stack: 'next-ts' }] })
})

test('vollständige quality.yml wie im Bauplan', () => {
  const y = `version: 1
level: strict
baseline: true
components:
  - path: ads-cockpit/backend
    stack: laravel
    php: "8.3"
    phpstan_level: 5      # gemessen: 429 Fehler
  - path: ads-cockpit/frontend
    stack: react-ts
`
  const c = parseYaml(y)
  assert.equal(c.level, 'strict')
  assert.equal(c.baseline, true)
  assert.equal(c.components.length, 2)
  assert.equal(c.components[0].phpstan_level, 5)
  assert.equal(c.components[1].stack, 'react-ts')
})

test('Inline-Liste', () => {
  assert.deepEqual(parseYaml('pfade: [app, database, routes]'), {
    pfade: ['app', 'database', 'routes'],
  })
})

test('verschachtelte Map', () => {
  const y = `security:
  gitleaks: true
  audit:
    php: true
    js: false
`
  assert.deepEqual(parseYaml(y), {
    security: { gitleaks: true, audit: { php: true, js: false } },
  })
})

test('Tabulatoren werden abgelehnt', () => {
  assert.throws(() => parseYaml('a:\n\tb: 1'), YamlError)
})

test('fehlender Doppelpunkt wird abgelehnt', () => {
  assert.throws(() => parseYaml('kaputt'), YamlError)
})

test('leere Datei ergibt leere Map', () => {
  assert.deepEqual(parseYaml(''), {})
  assert.deepEqual(parseYaml('# nur ein Kommentar\n'), {})
})

test('Doppelpunkt im Wert bleibt erhalten', () => {
  assert.deepEqual(parseYaml('url: https://example.com/pfad'), {
    url: 'https://example.com/pfad',
  })
})

test('Sequenz direkt unter Schlüssel ohne Zusatzeinrückung', () => {
  const y = `components:
- path: .
  stack: laravel
`
  assert.deepEqual(parseYaml(y), { components: [{ path: '.', stack: 'laravel' }] })
})
