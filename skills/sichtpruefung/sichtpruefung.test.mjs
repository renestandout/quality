import { after, test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync } from 'node:fs'
import { mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { execFileSync, spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs, hatUeberlauf, pruefe, main } from './sichtpruefung.mjs'

// Die Tests bekommen ein eigenes Temp-Verzeichnis. Eine parallele
// Sichtprüfung legt sonst Profile im gemeinsamen Temp-Verzeichnis an, und die
// Prüfung «räumt auf» meldet fremde Profile als Rest. os.tmpdir() liest TMPDIR
// bei jedem Aufruf. Das Skript und der CLI-Kindprozess übernehmen den Wert.
const eigenesTemp = mkdtempSync(path.join(os.tmpdir(), 'sichtpruefung-tests-'))
process.env['TMPDIR'] = eigenesTemp
after(() => rm(eigenesTemp, { recursive: true, force: true }))

test('parseArgs löst eine lokale Datei zur file-URL auf und setzt Standardwerte', () => {
  const opt = parseArgs(['seite.html'], '/x')
  assert.equal(opt.ziel, 'file:///x/seite.html')
  assert.deepEqual(opt.breiten, [1100, 320])
  assert.deepEqual(opt.schemata, ['hell', 'dunkel'])
  assert.deepEqual(opt.selektoren, [])
  assert.equal(opt.aus, null)
  assert.equal(opt.frist, 30)
})

test('parseArgs übernimmt URL, Breiten, Schemata, Selektoren und Ausgabeordner', () => {
  const opt = parseArgs(
    [
      'https://a.ch',
      '--frist',
      '5',
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
  assert.equal(opt.frist, 5)
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

// Auf dem CI-Runner liest der erste Chrome-Start die Programmdateien kalt von
// der Platte. Das dauerte bis zu 11 s (Diagnose-Lauf 43471596973).
test('pruefe: ein Chrome mit 11 s Kaltstart liefert trotzdem einen Befund', async () => {
  const echt = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
  ].find((p) => existsSync(p))
  assert.ok(echt, 'kein Chrome installiert')
  const langsam = path.join(await ordner('sichtpruefung-langsam-'), 'chrome')
  await writeFile(langsam, `#!/bin/sh\nsleep 11\nexec "${echt}" "$@"\n`, { mode: 0o755 })
  const alt = process.env['SICHTPRUEFUNG_CHROME']
  process.env['SICHTPRUEFUNG_CHROME'] = langsam
  try {
    const { befund } = await pruefeFixture('ok.html')
    assert.equal(befund.varianten.length, 4)
  } finally {
    if (alt === undefined) delete process.env['SICHTPRUEFUNG_CHROME']
    else process.env['SICHTPRUEFUNG_CHROME'] = alt
  }
})

/** Zählt laufende Chrome-Prozesse mit Wegwerf-Profil aus diesen Tests. */
function chromeProzesse() {
  const muster = path
    .join(eigenesTemp, 'sichtpruefung-profil-')
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try {
    return execFileSync('pgrep', ['-f', muster], { encoding: 'utf8' }).trim().split('\n').length
  } catch {
    return 0
  }
}

/** Startet einen Server, der Verbindungen annimmt und nie antwortet. */
async function stummerServer() {
  const server = createServer(() => {})
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)))
  const adresse = /** @type {import('node:net').AddressInfo} */ (server.address())
  return {
    url: `http://127.0.0.1:${adresse.port}/`,
    schliesse: () => {
      server.closeAllConnections()
      server.close()
    },
  }
}

/**
 * Prüft Exit 2, Dauer unter der Grenze und dass nichts zurückbleibt.
 * @param {() => Promise<number>} lauf
 * @param {number} grenzeMs
 */
async function erwarteSauberenAbbruch(lauf, grenzeMs) {
  const vorher = await profile()
  const prozesseVorher = chromeProzesse()
  const start = Date.now()
  assert.equal(await lauf(), 2)
  assert.ok(Date.now() - start < grenzeMs, `dauerte ${Date.now() - start} ms`)
  assert.deepEqual(await profile(), vorher)
  assert.equal(chromeProzesse(), prozesseVorher)
}

test('main: unbekanntes Schema ergibt Exit 2', async () => {
  assert.equal(await main([fixture('ok.html'), '--schemata', 'grau'], { quiet: true }), 2)
})

test('pruefe: Selektor ohne Treffer meldet keine Elemente', async () => {
  const aus = await ordner('sichtpruefung-test-')
  const befund = await pruefe({
    ...parseArgs([fixture('ok.html'), '--breiten', '320', '--schemata', 'hell'], '/'),
    selektoren: ['.gibtesnicht'],
    aus,
  })
  assert.deepEqual(befund.varianten[0]?.elemente, [])
})

test('main: Datei fehlt ergibt Exit 2 ohne Wartezeit', async () => {
  const aus = await ordner('sichtpruefung-test-')
  await erwarteSauberenAbbruch(
    () => main([fixture('fehlt.html'), '--aus', aus], { quiet: true }),
    8000,
  )
})

test('main: Server antwortet nie ergibt Exit 2 nach der Frist und räumt auf', async () => {
  const server = await stummerServer()
  const aus = await ordner('sichtpruefung-test-')
  try {
    await erwarteSauberenAbbruch(
      () => main([server.url, '--frist', '2', '--aus', aus], { quiet: true }),
      10000,
    )
  } finally {
    server.schliesse()
  }
})

test('main: blockierte Seite ergibt Exit 2 nach der Frist und räumt auf', async () => {
  const aus = await ordner('sichtpruefung-test-')
  await erwarteSauberenAbbruch(
    () => main([fixture('endlos.html'), '--frist', '2', '--aus', aus], { quiet: true }),
    10000,
  )
})

test('main: Absturz von Chrome ergibt Exit 2 und räumt auf', async () => {
  const aus = await ordner('sichtpruefung-test-')
  await erwarteSauberenAbbruch(
    () =>
      main(['chrome://inducebrowsercrashforrealz', '--frist', '5', '--aus', aus], { quiet: true }),
    15000,
  )
})

test('CLI: SIGTERM beendet Chrome, löscht das Profil und endet mit Exit 2', async () => {
  const server = await stummerServer()
  const aus = await ordner('sichtpruefung-test-')
  const vorher = await profile()
  try {
    const skript = fileURLToPath(new URL('./sichtpruefung.mjs', import.meta.url))
    const kind = spawn(process.execPath, [skript, server.url, '--aus', aus], { stdio: 'ignore' })
    const ende = Date.now() + 10000
    while ((await profile()).length === vorher.length && Date.now() < ende)
      await new Promise((r) => setTimeout(r, 50))
    await new Promise((r) => setTimeout(r, 1000))
    kind.kill('SIGTERM')
    const code = await new Promise((r) => kind.once('exit', (c) => r(c)))
    assert.equal(code, 2)
    await new Promise((r) => setTimeout(r, 500))
    assert.deepEqual(await profile(), vorher)
    assert.equal(chromeProzesse(), 0)
  } finally {
    server.schliesse()
  }
})

test('CLI: Aufruf über einen Symlink ergibt Exit 1 und schreibt befund.json', async () => {
  const basis = await ordner('sichtpruefung-link-')
  const link = path.join(basis, 'skill')
  await symlink(path.dirname(fileURLToPath(import.meta.url)), link, 'dir')
  const aus = path.join(basis, 'aus')
  const lauf = spawnSync(
    process.execPath,
    [
      path.join(link, 'sichtpruefung.mjs'),
      fixture('ueberlauf.html'),
      '--selektor',
      '.flaeche',
      '--aus',
      aus,
    ],
    { encoding: 'utf8' },
  )
  assert.equal(lauf.status, 1, lauf.stderr)
  const befund = JSON.parse(await readFile(path.join(aus, 'befund.json'), 'utf8'))
  assert.equal(befund.ziel, fixture('ueberlauf.html'))
})
