import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { parseArgs, hatUeberlauf, pruefe, main } from './sichtpruefung.mjs'

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

const fixture = (/** @type {string} */ name) => new URL(`./fixtures/${name}`, import.meta.url).href

/** @type {string[]} */
const angelegt = []
after(() => Promise.all(angelegt.map((o) => rm(o, { recursive: true, force: true }))))

/** @param {string} praefix */
async function ordner(praefix) {
  const o = await mkdtemp(path.join(os.tmpdir(), praefix))
  angelegt.push(o)
  return o
}

async function profile() {
  return (await readdir(os.tmpdir())).filter((n) => n.startsWith('sichtpruefung-profil-'))
}

/** @param {string} name */
async function pruefeFixture(name) {
  const aus = await ordner('sichtpruefung-test-')
  const befund = await pruefe({ ...parseArgs([fixture(name)], '/'), selektoren: ['.flaeche'], aus })
  return { aus, befund }
}

/** @param {import('./sichtpruefung.mjs').Befund} befund */
function ueberlaufend(befund) {
  return befund.varianten
    .filter((v) => v.seiteUeberlaeuft || v.elemente.length > 0)
    .map((v) => `${v.breite}-${v.schema}`)
}

/** @param {string} datei */
async function istPng(datei) {
  const kopf = (await readFile(datei)).subarray(0, 8)
  return kopf.equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
}

test('pruefe: Seite ohne Überlauf meldet keine Variante und speichert vier PNGs', async () => {
  const { aus, befund } = await pruefeFixture('ok.html')
  assert.deepEqual(ueberlaufend(befund), [])
  assert.equal(befund.varianten.length, 4)
  for (const v of befund.varianten) {
    assert.equal(v.png, path.join(aus, `${v.breite}-${v.schema}.png`))
    assert.ok(await istPng(v.png), `${v.png} ist kein PNG`)
  }
})

test('pruefe: überlaufende .flaeche zeigt sich nur auf 320 px', async () => {
  const { befund } = await pruefeFixture('ueberlauf.html')
  assert.deepEqual(ueberlaufend(befund), ['320-hell', '320-dunkel'])
  const v = befund.varianten.find((x) => x.breite === 320 && x.schema === 'hell')
  assert.equal(v?.seiteUeberlaeuft, false)
  assert.equal(v?.elemente.length, 1)
  assert.equal(v?.elemente[0]?.selektor, '.flaeche')
  assert.equal(v?.elemente[0]?.index, 0)
  assert.equal(v?.elemente[0]?.scrollWidth, 600)
  assert.ok((v?.elemente[0]?.clientWidth ?? 999) < 320)
})

test('pruefe: Seite überläuft nur im Dunkelmodus', async () => {
  const { befund } = await pruefeFixture('dunkel.html')
  assert.deepEqual(ueberlaufend(befund), ['1100-dunkel', '320-dunkel'])
  const v = befund.varianten.find((x) => x.breite === 1100 && x.schema === 'dunkel')
  assert.ok((v?.seite.scrollWidth ?? 0) >= 2000)
})

test('main: Überlauf ergibt Exit 1 und einen lesbaren befund.json', async () => {
  const aus = await ordner('sichtpruefung-test-')
  const code = await main([fixture('ueberlauf.html'), '--selektor', '.flaeche', '--aus', aus], {
    quiet: true,
  })
  assert.equal(code, 1)
  const befund = JSON.parse(await readFile(path.join(aus, 'befund.json'), 'utf8'))
  assert.equal(befund.ziel, fixture('ueberlauf.html'))
})

test('main: fehlendes Chrome ergibt Exit 2 und lässt kein Profil zurück', async () => {
  const vorher = await profile()
  const aus = await ordner('sichtpruefung-test-')
  const alt = process.env['SICHTPRUEFUNG_CHROME']
  process.env['SICHTPRUEFUNG_CHROME'] = '/gibt/es/nicht'
  try {
    const code = await main([fixture('ok.html'), '--aus', aus], { quiet: true })
    assert.equal(code, 2)
  } finally {
    if (alt === undefined) delete process.env['SICHTPRUEFUNG_CHROME']
    else process.env['SICHTPRUEFUNG_CHROME'] = alt
  }
  assert.deepEqual(await profile(), vorher)
})
