/**
 * Wie die Zusammenfassung einen weichen Schritt wertet.
 *
 * Ein weicher Schritt ist ein Hinweis, keine Prüfung: er darf das Gate nicht
 * färben und nicht in der Summe auftauchen. Der fmt-Schritt in `task` und
 * `full` erzeugt mit `--base` genau so einen — er meldet Formatierung
 * ausserhalb des Diffs, für die dieser Zweig nicht einsteht.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { summarize } from './run.mjs'

/** Fängt auf, was summarize schreibt, und gibt Text und Rückgabewert zurück. */
function lauf(results) {
  const original = process.stdout.write
  let text = ''
  process.stdout.write = (chunk) => {
    text += chunk
    return true
  }
  try {
    const code = summarize(results, { label: 'quality task' })
    return { text, code }
  } finally {
    process.stdout.write = original
  }
}

const hart = (code = 0) => ({ name: 'prettier (prüfend) (.)', code })
const weich = (code = 0, extra = {}) => ({ name: 'prettier — ganze Fläche', code, soft: true, ...extra })

test('Ein weicher Fund färbt das Gate nicht', () => {
  const { text, code } = lauf([hart(0), weich(1, { note: 'blockiert nicht' })])

  assert.equal(code, 0)
  assert.match(text, /prettier — ganze Fläche/)
  assert.doesNotMatch(text, /fehlgeschlagen/)
})

test('Ein weicher Schritt zählt nicht als Prüfung', () => {
  const { text } = lauf([hart(0), weich(1)])

  assert.match(text, /1 Prüfung bestanden/)
})

test('Ein weicher Schritt ohne Fund bekommt keine Zeile', () => {
  const { text, code } = lauf([hart(0), weich(0)])

  assert.equal(code, 0)
  assert.doesNotMatch(text, /ganze Fläche/)
})

test('Ein übersprungener weicher Schritt wiederholt den harten nicht', () => {
  // Fehlt das Werkzeug, sagt das schon der harte Lauf. Zweimal dieselbe
  // Zeile ist keine zweite Auskunft.
  const uebersprungen = { name: 'prettier', code: 0, skipped: true, reason: 'Werkzeug nicht gefunden' }
  const { text } = lauf([uebersprungen, { ...uebersprungen, name: 'prettier — ganze Fläche', soft: true }])

  assert.doesNotMatch(text, /ganze Fläche/)
  assert.match(text, /Werkzeug nicht gefunden/)
})

test('Ein harter Fehler bleibt ein Fehler', () => {
  const { text, code } = lauf([hart(1), weich(1)])

  assert.equal(code, 1)
  assert.match(text, /1 von 1 Prüfungen fehlgeschlagen/)
})
