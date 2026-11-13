import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseArgs, hatUeberlauf } from './sichtpruefung.mjs'

test('parseArgs löst eine lokale Datei zur file-URL auf und setzt Standardwerte', () => {
  const opt = parseArgs(['seite.html'], '/x')
  assert.equal(opt.ziel, 'file:///x/seite.html')
  assert.deepEqual(opt.breiten, [1100, 320])
  assert.deepEqual(opt.schemata, ['hell', 'dunkel'])
  assert.deepEqual(opt.selektoren, [])
  assert.equal(opt.aus, null)
})

test('parseArgs übernimmt URL, Breiten, Schemata, Selektoren und Ausgabeordner', () => {
  const opt = parseArgs(
    [
      'https://a.ch',
      '--breiten',
      '800',
      '--schemata',
      'dunkel',
      '--selektor',
      '.a',
      '--selektor',
      '.b',
      '--aus',
      'o',
    ],
    '/x',
  )
  assert.equal(opt.ziel, 'https://a.ch')
  assert.deepEqual(opt.breiten, [800])
  assert.deepEqual(opt.schemata, ['dunkel'])
  assert.deepEqual(opt.selektoren, ['.a', '.b'])
  assert.equal(opt.aus, '/x/o')
})

test('parseArgs wirft bei unbekanntem Schema, Breite 0 und fehlendem Ziel', () => {
  assert.throws(() => parseArgs(['a.html', '--schemata', 'grau'], '/x'))
  assert.throws(() => parseArgs(['a.html', '--breiten', '0'], '/x'))
  assert.throws(() => parseArgs([], '/x'))
})

test('hatUeberlauf meldet Seite oder Element, sonst nicht', () => {
  /** @param {boolean} seiteUeberlaeuft @param {unknown[]} elemente */
  const v = (seiteUeberlaeuft, elemente) => ({ varianten: [{ seiteUeberlaeuft, elemente }] })
  assert.equal(hatUeberlauf(v(false, [])), false)
  assert.equal(hatUeberlauf(v(true, [])), true)
  assert.equal(hatUeberlauf(v(false, [{}])), true)
})
