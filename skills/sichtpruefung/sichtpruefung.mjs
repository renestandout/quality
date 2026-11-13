#!/usr/bin/env node
// Sichtprüfung: misst eine Seite headless auf horizontalen Überlauf und speichert PNGs.
// Chrome läuft mit Wegwerf-Profil. Das persönliche Profil bleibt unberührt.
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const SCHEMATA = /** @type {const} */ (['hell', 'dunkel'])

/**
 * @typedef {'hell' | 'dunkel'} Schema
 * @typedef {{ziel: string, breiten: number[], schemata: Schema[], selektoren: string[], aus: string | null}} Optionen
 */

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
