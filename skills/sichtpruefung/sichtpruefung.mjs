#!/usr/bin/env node
// Sichtprüfung: misst eine Seite headless auf horizontalen Überlauf und speichert PNGs.
// Chrome läuft mit Wegwerf-Profil. Das persönliche Profil bleibt unberührt.
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCHEMATA = /** @type {const} */ (['hell', 'dunkel'])

/**
 * @typedef {'hell' | 'dunkel'} Schema
 * @typedef {{ziel: string, breiten: number[], schemata: Schema[], selektoren: string[], aus: string | null}} Optionen
 * @typedef {{selektor: string, index: number, scrollWidth: number, clientWidth: number}} Element
 * @typedef {{breite: number, schema: Schema, seiteUeberlaeuft: boolean, seite: {scrollWidth: number, clientWidth: number}, elemente: Element[], png: string}} Variante
 * @typedef {{ziel: string, erstellt: string, varianten: Variante[]}} Befund
 */

const CHROME_KANDIDATEN = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
]
const START_FRIST_MS = 10_000
const SEITEN_FRIST_MS = 30_000
const HOEHE = 800

/**
 * Liest die Argumente der Kommandozeile.
 * @param {string[]} argv
 * @param {string} cwd
 * @returns {Optionen}
 */
export function parseArgs(argv, cwd) {
  /** @type {Optionen} */
  const opt = {
    ziel: '',
    breiten: [1100, 320],
    schemata: ['hell', 'dunkel'],
    selektoren: [],
    aus: null,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] ?? ''
    if (!arg.startsWith('--')) {
      if (opt.ziel !== '') throw new Error(`Zweites Ziel nicht erlaubt: ${arg}`)
      opt.ziel = /^[a-z][a-z0-9+.-]*:/i.test(arg) ? arg : pathToFileURL(path.resolve(cwd, arg)).href
      continue
    }
    const wert = argv[++i]
    if (wert === undefined) throw new Error(`${arg} braucht einen Wert`)
    if (arg === '--breiten') {
      opt.breiten = wert.split(',').map(Number)
      if (opt.breiten.some((b) => !Number.isInteger(b) || b <= 0))
        throw new Error(`Ungültige Breiten: ${wert}`)
    } else if (arg === '--schemata') {
      const liste = wert.split(',')
      for (const s of liste) {
        if (!SCHEMATA.includes(/** @type {Schema} */ (s)))
          throw new Error(`Unbekanntes Schema: ${s} (erlaubt: hell, dunkel)`)
      }
      opt.schemata = /** @type {Schema[]} */ (liste)
    } else if (arg === '--selektor') {
      opt.selektoren.push(wert)
    } else if (arg === '--aus') {
      opt.aus = path.resolve(cwd, wert)
    } else {
      throw new Error(`Unbekannte Option: ${arg}`)
    }
  }
  if (opt.ziel === '') throw new Error('Ziel fehlt: URL oder HTML-Datei angeben')
  return opt
}

/**
 * Meldet, ob eine Variante des Befunds überläuft.
 * @param {{varianten: {seiteUeberlaeuft: boolean, elemente: unknown[]}[]}} befund
 * @returns {boolean}
 */
export function hatUeberlauf(befund) {
  return befund.varianten.some((v) => v.seiteUeberlaeuft || v.elemente.length > 0)
}

/**
 * Findet das Chrome-Programm. SICHTPRUEFUNG_CHROME hat Vorrang.
 * @returns {string}
 */
function findeChrome() {
  const env = process.env['SICHTPRUEFUNG_CHROME']
  if (env) return env
  const treffer = CHROME_KANDIDATEN.find((p) => existsSync(p))
  if (!treffer) throw new Error(`Chrome nicht gefunden. Gesucht: ${CHROME_KANDIDATEN.join(', ')}`)
  return treffer
}

/** @param {number} ms */
const warte = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * Startet Chrome headless mit dem Profil und liefert den DevTools-Port.
 * @param {string} profil
 * @returns {Promise<{prozess: import('node:child_process').ChildProcess, port: number}>}
 */
async function starteChrome(profil) {
  const prozess = spawn(
    findeChrome(),
    [
      '--headless',
      '--remote-debugging-port=0',
      `--user-data-dir=${profil}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  /** @type {Error | null} */
  let fehler = null
  prozess.once('error', (e) => (fehler = new Error(`Chrome startet nicht: ${e.message}`)))
  prozess.once('exit', (code) => (fehler ??= new Error(`Chrome endete beim Start (Code ${code})`)))
  const datei = path.join(profil, 'DevToolsActivePort')
  const ende = Date.now() + START_FRIST_MS
  while (Date.now() < ende) {
    if (fehler) throw fehler
    if (existsSync(datei)) {
      const port = Number((await readFile(datei, 'utf8')).split('\n')[0])
      if (port > 0) return { prozess, port }
    }
    await warte(50)
  }
  prozess.kill('SIGKILL')
  throw new Error(`Chrome meldete nach ${START_FRIST_MS / 1000} s keinen DevTools-Port`)
}

/**
 * Beendet Chrome und wartet auf das Ende des Prozesses.
 * @param {import('node:child_process').ChildProcess} prozess
 */
async function beendeChrome(prozess) {
  if (prozess.exitCode !== null || prozess.signalCode !== null) return
  const beendet = new Promise((r) => prozess.once('exit', r))
  prozess.kill('SIGTERM')
  const hart = setTimeout(() => prozess.kill('SIGKILL'), 3000)
  await beendet
  clearTimeout(hart)
}

/**
 * Minimaler CDP-Client über den eingebauten WebSocket.
 * @param {string} url
 */
async function verbinde(url) {
  const ws = new WebSocket(url)
  await new Promise((ok, nein) => {
    ws.addEventListener('open', ok, { once: true })
    ws.addEventListener('error', () => nein(new Error('DevTools-Verbindung fehlgeschlagen')), {
      once: true,
    })
  })
  let naechste = 0
  /** @type {Map<number, {ok: (v: any) => void, nein: (e: Error) => void}>} */
  const offen = new Map()
  /** @type {Map<string, ((p: any) => void)[]>} */
  const warter = new Map()
  ws.addEventListener('message', (ereignis) => {
    const nachricht = JSON.parse(String(ereignis.data))
    if (nachricht.id !== undefined) {
      const auftrag = offen.get(nachricht.id)
      offen.delete(nachricht.id)
      if (nachricht.error)
        auftrag?.nein(new Error(`${nachricht.error.message} (${nachricht.error.code})`))
      else auftrag?.ok(nachricht.result)
    } else {
      const liste = warter.get(nachricht.method) ?? []
      warter.delete(nachricht.method)
      for (const f of liste) f(nachricht.params)
    }
  })
  return {
    /**
     * @param {string} methode
     * @param {object} [params]
     * @returns {Promise<any>}
     */
    sende(methode, params = {}) {
      const id = ++naechste
      return new Promise((ok, nein) => {
        offen.set(id, { ok, nein })
        ws.send(JSON.stringify({ id, method: methode, params }))
      })
    },
    /**
     * @param {string} methode
     * @param {number} frist
     * @returns {Promise<any>}
     */
    ereignis(methode, frist) {
      return new Promise((ok, nein) => {
        const t = setTimeout(
          () => nein(new Error(`${methode} kam nicht innert ${frist / 1000} s`)),
          frist,
        )
        warter.set(methode, [
          ...(warter.get(methode) ?? []),
          (p) => {
            clearTimeout(t)
            ok(p)
          },
        ])
      })
    },
    schliesse() {
      ws.close()
    },
  }
}

/**
 * Misst im Browser die Seite und die Elemente der Selektoren.
 * @param {string[]} selektoren
 */
function messAusdruck(selektoren) {
  return `(() => {
    const d = document.documentElement
    const elemente = []
    for (const selektor of ${JSON.stringify(selektoren)}) {
      document.querySelectorAll(selektor).forEach((el, index) => {
        if (el.scrollWidth > el.clientWidth) {
          elemente.push({ selektor, index, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth })
        }
      })
    }
    return { seite: { scrollWidth: d.scrollWidth, clientWidth: d.clientWidth }, elemente }
  })()`
}

/**
 * Prüft das Ziel je Breite und Schema, speichert PNGs und befund.json.
 * @param {Optionen & {aus: string}} opt
 * @returns {Promise<Befund>}
 */
export async function pruefe(opt) {
  await mkdir(opt.aus, { recursive: true })
  const profil = await mkdtemp(path.join(os.tmpdir(), 'sichtpruefung-profil-'))
  /** @type {import('node:child_process').ChildProcess | null} */
  let prozess = null
  /** @type {Awaited<ReturnType<typeof verbinde>> | null} */
  let cdp = null
  try {
    const chrome = await starteChrome(profil)
    prozess = chrome.prozess
    const antwort = await fetch(`http://127.0.0.1:${chrome.port}/json/new?about:blank`, {
      method: 'PUT',
    })
    if (!antwort.ok) throw new Error(`DevTools: neuer Tab scheitert (${antwort.status})`)
    const tab = /** @type {{webSocketDebuggerUrl: string}} */ (await antwort.json())
    cdp = await verbinde(tab.webSocketDebuggerUrl)
    await cdp.sende('Page.enable')

    /** @type {Variante[]} */
    const varianten = []
    for (const breite of opt.breiten) {
      for (const schema of opt.schemata) {
        await cdp.sende('Emulation.setDeviceMetricsOverride', {
          width: breite,
          height: HOEHE,
          deviceScaleFactor: 1,
          mobile: false,
        })
        await cdp.sende('Emulation.setEmulatedMedia', {
          features: [
            { name: 'prefers-color-scheme', value: schema === 'dunkel' ? 'dark' : 'light' },
          ],
        })
        const geladen = cdp.ereignis('Page.loadEventFired', SEITEN_FRIST_MS)
        const nav = await cdp.sende('Page.navigate', { url: opt.ziel })
        if (nav.errorText) {
          geladen.catch(() => {})
          throw new Error(`Seite lädt nicht: ${opt.ziel} (${nav.errorText})`)
        }
        await geladen
        await cdp.sende('Runtime.evaluate', {
          expression: 'document.fonts.ready.then(() => true)',
          awaitPromise: true,
        })
        const mess = await cdp.sende('Runtime.evaluate', {
          expression: messAusdruck(opt.selektoren),
          returnByValue: true,
        })
        if (mess.exceptionDetails) {
          throw new Error(
            `Messung scheitert: ${mess.exceptionDetails.exception?.description ?? mess.exceptionDetails.text}`,
          )
        }
        /** @type {{seite: Variante['seite'], elemente: Element[]}} */
        const wert = mess.result.value
        const masse = await cdp.sende('Page.getLayoutMetrics')
        const bild = await cdp.sende('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: true,
          clip: {
            x: 0,
            y: 0,
            width: masse.cssContentSize.width,
            height: masse.cssContentSize.height,
            scale: 1,
          },
        })
        const png = path.join(opt.aus, `${breite}-${schema}.png`)
        await writeFile(png, Buffer.from(bild.data, 'base64'))
        varianten.push({
          breite,
          schema,
          seiteUeberlaeuft: wert.seite.scrollWidth > wert.seite.clientWidth,
          seite: wert.seite,
          elemente: wert.elemente,
          png,
        })
      }
    }
    /** @type {Befund} */
    const befund = { ziel: opt.ziel, erstellt: new Date().toISOString(), varianten }
    await writeFile(path.join(opt.aus, 'befund.json'), JSON.stringify(befund, null, 2) + '\n')
    return befund
  } finally {
    cdp?.schliesse()
    if (prozess) await beendeChrome(prozess)
    await rm(profil, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
}

/**
 * Kommandozeile: liefert 0 ohne Überlauf, 1 mit Überlauf, 2 bei Fehler.
 * @param {string[]} argv
 * @param {{quiet?: boolean}} [einstellung]
 * @returns {Promise<number>}
 */
export async function main(argv, einstellung = {}) {
  try {
    const opt = parseArgs(argv, process.cwd())
    const stempel = new Date().toISOString().replace(/[:.]/g, '-')
    const aus = opt.aus ?? path.join(os.tmpdir(), `sichtpruefung-${stempel}`)
    const befund = await pruefe({ ...opt, aus })
    if (!einstellung.quiet) process.stdout.write(JSON.stringify(befund, null, 2) + '\n')
    return hatUeberlauf(befund) ? 1 : 0
  } catch (error) {
    if (!einstellung.quiet)
      process.stderr.write(`sichtpruefung: ${/** @type {Error} */ (error).message}\n`)
    return 2
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await main(process.argv.slice(2))
}
