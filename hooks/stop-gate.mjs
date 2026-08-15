#!/usr/bin/env node
/**
 * Stop: prüft vor dem Task-Abschluss `quality fast` und blockiert, solange
 * etwas rot ist.
 *
 * Das ist die riskanteste Komponente des Frameworks. Ein Gate, das zu oft oder
 * zu lange blockiert, verbrennt Kontext und provoziert genau die kreativen
 * Umgehungen, die es verhindern soll. Deshalb drei Sicherungen:
 *
 *   1. Nur die schnelle Stufe, nie Tests.
 *   2. Harte Zeitgrenze; ein Timeout lässt durch, statt zu blockieren.
 *   3. Nach drei erfolglosen Runden endet das Blockieren. Die letzte Meldung
 *      weist den Agenten an, dem Menschen zu berichten, statt weiterzubasteln.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { findProjectRoot, readHookInput, runQuality } from './lib/hook-io.mjs'

const TIMEOUT_MS = 45_000
const MAX_ATTEMPTS = 3
const STATE_MAX_AGE_MS = 6 * 60 * 60 * 1000

const stateDir = join(tmpdir(), 'standout-quality')

function stateFile(sessionId) {
  const safe = String(sessionId ?? 'unbekannt').replace(/[^a-zA-Z0-9_-]/g, '')
  return join(stateDir, `stop-${safe}.json`)
}

function readAttempts(file) {
  try {
    const state = JSON.parse(readFileSync(file, 'utf8'))
    if (Date.now() - state.ts > STATE_MAX_AGE_MS) return 0
    return Number(state.count) || 0
  } catch {
    return 0
  }
}

function writeAttempts(file, count) {
  try {
    mkdirSync(stateDir, { recursive: true })
    writeFileSync(file, JSON.stringify({ count, ts: Date.now() }))
  } catch {
    // Kein Zustand schreibbar: dann greift Claude Codes eigene Wiederholungsgrenze.
  }
}

function clearAttempts(file) {
  try {
    if (existsSync(file)) rmSync(file)
  } catch {
    /* egal */
  }
}

const input = await readHookInput()
const root = findProjectRoot(input.cwd ?? process.cwd())
if (!root) process.exit(0)

const file = stateFile(input.session_id)
const attempts = readAttempts(file)

if (attempts >= MAX_ATTEMPTS) {
  // Der Agent wurde bereits aufgefordert zu berichten — jetzt nicht weiter
  // im Weg stehen, sonst dreht sich die Runde endlos.
  clearAttempts(file)
  process.exit(0)
}

// Ohne --quiet, damit die Meldungen der Werkzeuge beim Agenten ankommen und
// nicht nur die Aussage, dass etwas rot ist.
const { code, output, timedOut } = runQuality(['fast'], { cwd: root, timeoutMs: TIMEOUT_MS })

if (timedOut) {
  process.stderr.write(
    'Die Qualitätsprüfung lief in die Zeitgrenze und wurde übersprungen. ' +
      'Erwähne das gegenüber dem Menschen — der Stand ist ungeprüft.\n'
  )
  clearAttempts(file)
  process.exit(0)
}

if (code === 0) {
  clearAttempts(file)
  process.exit(0)
}

const next = attempts + 1
writeAttempts(file, next)

if (next >= MAX_ATTEMPTS) {
  process.stderr.write(
    `Die Qualitätsprüfung ist nach ${MAX_ATTEMPTS} Versuchen weiterhin rot:\n\n${output.trim()}\n\n` +
      `Hör hier auf zu reparieren. Berichte dem Menschen, was rot bleibt und was du ` +
      `versucht hast, und frage nach dem weiteren Vorgehen. Schalte die Prüfung nicht ab ` +
      `und arbeite nicht mit Suppressions.\n`
  )
  process.exit(2)
}

process.stderr.write(
  `Die Qualitätsprüfung ist rot (Versuch ${next} von ${MAX_ATTEMPTS}):\n\n${output.trim()}\n\n` +
    `Behebe die Ursache und schliesse den Task danach erneut ab.\n`
)
process.exit(2)
