#!/usr/bin/env node
/**
 * PostToolUse: formatiert und lintet die gerade geänderte Datei.
 *
 * Läuft nach jedem Edit und muss deshalb billig sein — geprüft wird genau
 * eine Datei, nicht das Projekt. Findet der Linter etwas, geht die Meldung
 * über Exit-Code 2 als Feedback an den Agenten, der sie sofort beheben kann,
 * statt später in CI darüber zu stolpern.
 *
 * Bewusst NICHT gefiltert auf "nur neue Fehler": das zuverlässig zu tun
 * verlangt tool-spezifisches Parsen der Ausgaben. In Projekten mit vielen
 * Altlasten kann der Hook deshalb Meldungen zeigen, die nicht von dieser
 * Änderung stammen — die Meldung sagt das dazu.
 */
import { findProjectRoot, readHookInput, relativeToRoot, runQuality } from './lib/hook-io.mjs'

const TIMEOUT_MS = 8000

const input = await readHookInput()
const filePath = input?.tool_input?.file_path
if (!filePath) process.exit(0)

const root = findProjectRoot(input.cwd ?? process.cwd())
if (!root) process.exit(0) // Kein Projekt mit Gate — nichts zu tun.

const relativePath = relativeToRoot(filePath, root)
if (!relativePath) process.exit(0) // Datei liegt ausserhalb des Projekts.

// Bewusst ohne --quiet: der Agent braucht die konkrete Meldung des Werkzeugs
// ("Zeile 12: …"), nicht bloss die Information, dass etwas rot ist. Ein Gate,
// das nur "fehlgeschlagen" sagt, kann niemand beheben.
const { code, output, timedOut } = runQuality(['fix', '--files', relativePath], {
  cwd: root,
  timeoutMs: TIMEOUT_MS,
})

if (timedOut || code === 0) process.exit(0)

// Exit 2 leitet stderr als Feedback an den Agenten weiter.
process.stderr.write(
  `Qualitätsprüfung von ${relativePath} meldet Folgendes:\n\n${output.trim()}\n\n` +
    `Behebe, was zu deiner Änderung gehört. Bestand eine Meldung schon vorher, ` +
    `lass sie stehen und erwähne sie — repariere sie nicht nebenbei mit.\n` +
    `Suppressions sind keine Lösung.\n`
)
process.exit(2)
