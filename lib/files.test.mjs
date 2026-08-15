import assert from 'node:assert/strict'
import { test } from 'node:test'
import { filesForComponent, filesForVerb } from './files.mjs'

const backend = { path: 'ads-cockpit/backend', kind: 'php' }
const frontend = { path: 'ads-cockpit/frontend', kind: 'js' }
const root = '/repo'

test('Dateien werden der Komponente zugeordnet und relativ gemacht', () => {
  const files = [
    'ads-cockpit/backend/app/Service.php',
    'ads-cockpit/frontend/src/App.tsx',
    'docs/readme.md',
  ]
  assert.deepEqual(filesForComponent(backend, files, root), ['app/Service.php'])
  assert.deepEqual(filesForComponent(frontend, files, root), ['src/App.tsx'])
})

test('Komponente in der Wurzel bekommt die Pfade unverändert', () => {
  const files = ['src/a.ts', 'README.md']
  assert.deepEqual(filesForComponent({ path: '.', kind: 'js' }, files, root), files)
})

test('Absolute Pfade werden relativ zur Wurzel aufgelöst', () => {
  assert.deepEqual(filesForComponent(backend, ['/repo/ads-cockpit/backend/app/A.php'], root), ['app/A.php'])
})

test('Der Linter bekommt keine package.json', () => {
  // oxlint und eslint melden bei einer Datei, die sie nicht linten können,
  // "No files found to lint" und beenden mit 1. Jede Änderung an einer
  // Konfigurationsdatei hätte damit das Gate blockiert.
  const files = ['package.json', 'src/App.tsx', 'src/app.css', 'README.md']
  assert.deepEqual(filesForVerb('js', 'lint', files), ['src/App.tsx'])
  // Prettier dagegen kann alle vier.
  assert.deepEqual(filesForVerb('js', 'fmt', files), files)
})

test('Ohne Dateiliste bleibt es beim ganzen Projekt', () => {
  assert.equal(filesForVerb('js', 'lint', null), null)
})

test('PHP kennt nur eine Endung, deshalb keine Einschränkung je Werkzeug', () => {
  const files = ['app/A.php']
  assert.deepEqual(filesForVerb('php', 'types', files), files)
  assert.deepEqual(filesForVerb('php', 'fmt', files), files)
})
