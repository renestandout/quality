// TEMPORÄR: Diagnose des langsamen Chrome-Kaltstarts auf dem CI-Runner.
// Wird vor dem Merge wieder entfernt.
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const kandidaten = ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']

/** @param {string} msg */
const log = (msg) => process.stdout.write(`[DIAGNOSE] ${msg}\n`)

/** Liest alle Dateien des Chrome-Ordners und misst die Zeit. */
function leseOrdner(/** @type {string} */ ordner) {
  const t0 = performance.now()
  let bytes = 0
  /** @param {string} d */
  const lauf = (d) => {
    for (const n of readdirSync(d)) {
      const p = path.join(d, n)
      const s = statSync(p, { throwIfNoEntry: false })
      if (!s) continue
      if (s.isDirectory()) lauf(p)
      else if (s.isFile()) bytes += readFileSync(p).length
    }
  }
  lauf(ordner)
  log(
    `Ordner ${ordner} gelesen: ${(bytes / 1e6).toFixed(0)} MB in ${(performance.now() - t0).toFixed(0)} ms`,
  )
}

/** Startet Chrome mit Log auf stderr und misst die Zeit bis DevToolsActivePort. */
async function starte(/** @type {string} */ chrome, /** @type {string} */ name) {
  const profil = mkdtempSync(path.join(os.tmpdir(), 'diagnose-'))
  const t0 = performance.now()
  const p = spawn(
    chrome,
    [
      '--headless',
      '--remote-debugging-port=0',
      `--user-data-dir=${profil}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-gpu',
      '--disable-extensions',
      '--enable-logging=stderr',
      '--v=1',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'], detached: true },
  )
  /** @type {string[]} */
  const zeilen = []
  let rest = ''
  p.stderr?.on('data', (b) => {
    rest += b.toString()
    const teile = rest.split('\n')
    rest = teile.pop() ?? ''
    for (const z of teile)
      zeilen.push(`+${(performance.now() - t0).toFixed(0)}ms ${z.slice(0, 220)}`)
  })
  const datei = path.join(profil, 'DevToolsActivePort')
  let dauer = -1
  while (performance.now() - t0 < 40_000) {
    if (existsSync(datei) && readFileSync(datei, 'utf8').includes('\n')) {
      dauer = performance.now() - t0
      break
    }
    await new Promise((r) => setTimeout(r, 20))
  }
  try {
    process.kill(-(p.pid ?? 0), 'SIGKILL')
  } catch {}
  log(`${name}: DevTools-Port nach ${dauer.toFixed(0)} ms (-1 = nie)`)
  // Grosse Lücken zwischen zwei Log-Zeilen zeigen, worauf Chrome wartet.
  let vorher = 0
  for (const z of zeilen) {
    const ms = Number(z.slice(1, z.indexOf('ms')))
    if (ms - vorher > 300) log(`  Lücke ${ms - vorher} ms vor: ${z}`)
    vorher = ms
  }
  log(`  ${zeilen.length} Log-Zeilen. Erste 15 und letzte 15:`)
  for (const z of [...zeilen.slice(0, 15), '…', ...zeilen.slice(-15)]) log(`  ${z}`)
}

export async function diagnose() {
  const chrome = kandidaten.find((k) => existsSync(k))
  if (!chrome || process.platform !== 'linux') return
  const ordner = path.dirname(realpathSync(chrome))
  log(`Node ${process.version}, Chrome ${chrome} -> ${ordner}, CPUs ${os.cpus().length}`)
  // Node 24: erst den Ordner lesen, dann starten. Node 26: erst starten.
  // So zeigt ein Lauf beide Reihenfolgen.
  if (process.version.startsWith('v24')) leseOrdner(ordner)
  await starte(chrome, 'Start 1')
  await starte(chrome, 'Start 2')
  if (!process.version.startsWith('v24')) leseOrdner(ordner)
}
