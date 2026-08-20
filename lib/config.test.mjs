import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ConfigError, KNOWN_STACKS, validateConfig } from './config.mjs'

const base = { version: 1, components: [{ path: '.', stack: 'laravel' }] }

test('ohne configs-Block ist die Einbindungsprüfung überall aktiv', () => {
  const config = validateConfig({ ...base }, 'quality.yml')
  assert.deepEqual(config.configs, {})
})

test('configs: prettier: own wird übernommen', () => {
  const config = validateConfig({ ...base, configs: { prettier: 'own' } }, 'quality.yml')
  assert.deepEqual(config.configs, { prettier: 'own' })
})

test('ein unbekannter Schlüssel im configs-Block ist ein Fehler', () => {
  // Ein Tippfehler würde sonst still nichts abschalten — und der Hinweis, den
  // jemand loswerden wollte, bliebe stehen.
  assert.throws(
    () => validateConfig({ ...base, configs: { prettierrc: 'own' } }, 'quality.yml'),
    (error) => error instanceof ConfigError && /prettierrc/.test(error.message)
  )
})

test('ein unbekannter Wert im configs-Block ist ein Fehler', () => {
  assert.throws(
    () => validateConfig({ ...base, configs: { prettier: 'nein' } }, 'quality.yml'),
    (error) => error instanceof ConfigError && /own/.test(error.message)
  )
})

test('python ist ein bekannter Stack', () => {
  assert.ok(KNOWN_STACKS.includes('python'))
})
