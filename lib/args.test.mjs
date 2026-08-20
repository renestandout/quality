import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ONLY_NAMES, STAGES, parseArgs, planFor } from './args.mjs'

test('parseArgs: --only nimmt eine Liste, beide Schreibweisen', () => {
  assert.deepEqual(parseArgs(['task', '--only', 'fmt,lint,types']).only, ['fmt', 'lint', 'types'])
  assert.deepEqual(parseArgs(['task', '--only=fmt,lint']).only, ['fmt', 'lint'])
})

test('parseArgs: --only toleriert Leerzeichen nach dem Komma', () => {
  assert.deepEqual(parseArgs(['task', '--only=fmt, lint']).only, ['fmt', 'lint'])
})

test('parseArgs: ohne --only bleibt only null', () => {
  assert.equal(parseArgs(['full']).only, null)
})

test('parseArgs: unbekannter Schritt nennt die erlaubten', () => {
  assert.throws(() => parseArgs(['task', '--only=fmt,pruefen']), (err) => {
    assert.match(err.message, /"pruefen"/)
    assert.match(err.message, /fmt, lint, types, test, build, tamper/)
    return true
  })
})

test('parseArgs: --only ohne Wert ist ein Fehler, kein leerer Lauf', () => {
  assert.throws(() => parseArgs(['task', '--only', '']), /mindestens einen Schritt/)
})

test('parseArgs: --base nimmt beide Schreibweisen und trimmt', () => {
  assert.equal(parseArgs(['tamper', '--base', 'origin/main']).base, 'origin/main')
  assert.equal(parseArgs(['tamper', '--base=origin/main']).base, 'origin/main')
  assert.equal(parseArgs(['tamper', '--base', ' origin/main ']).base, 'origin/main')
})

// Ein leeres --base entsteht in CI leicht: ein Workflow-Ausdruck, der für
// dieses Ereignis nichts liefert. Fiele der Wert still auf null, prüfte der
// Tamper-Check den uncommitteten Stand und meldete grün, ohne einen Commit
// gesehen zu haben — ein Gate, das behauptet zu prüfen.
test('parseArgs: --base ohne Wert ist ein Fehler, kein stiller lokaler Lauf', () => {
  assert.throws(() => parseArgs(['tamper', '--base', '']), /erwartet eine Referenz/)
  assert.throws(() => parseArgs(['tamper', '--base=']), /erwartet eine Referenz/)
  assert.throws(() => parseArgs(['tamper', '--base']), /erwartet eine Referenz/)
})

test('planFor: ohne --only bleibt die Stufe unverändert', () => {
  const plan = planFor(STAGES.full, null)
  assert.deepEqual(plan.verbs, ['fmt', 'lint', 'types', 'test', 'build'])
  assert.equal(plan.tamper, true)
})

test('planFor: --only behält die Reihenfolge der Stufe, nicht die der Eingabe', () => {
  const plan = planFor(STAGES.full, ['types', 'fmt'])
  assert.deepEqual(plan.verbs, ['fmt', 'types'])
})

// Der Fall, für den --only gebaut wurde: der statische Teil als eigener
// CI-Job. Der Tamper-Check darf dabei nicht mitlaufen — er kommt im Workflow
// als eigener Schritt, weil nur dort ein --base zur Verfügung steht.
test('planFor: --only ohne "tamper" schaltet den Tamper-Nachlauf ab', () => {
  assert.equal(planFor(STAGES.task, ['fmt', 'lint', 'types']).tamper, false)
  assert.equal(planFor(STAGES.task, ['fmt', 'tamper']).tamper, true)
})

test('planFor: --only kann einer Stufe keinen Schritt hinzufügen', () => {
  const plan = planFor(STAGES.fix, ['fmt', 'test', 'tamper'])
  assert.deepEqual(plan.verbs, ['fmt'])
  assert.equal(plan.tamper, false, 'fix kennt keinen Tamper-Check')
})

test('planFor: eine Auswahl, die nichts übrig lässt, ist erkennbar leer', () => {
  const plan = planFor(STAGES.fix, ['build'])
  assert.deepEqual(plan.verbs, [])
  assert.equal(plan.tamper, false)
})

test('ONLY_NAMES deckt jeden Schritt ab, den eine Stufe kennt', () => {
  for (const [name, stage] of Object.entries(STAGES)) {
    for (const verb of stage.verbs) {
      assert.ok(ONLY_NAMES.includes(verb), `${name}: "${verb}" fehlt in ONLY_NAMES`)
    }
  }
})
