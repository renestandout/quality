#!/usr/bin/env node
/**
 * PreToolUse: verhindert, dass der Agent das Gate selbst umschreibt.
 *
 * Geschützt sind genau die Dateien, die definieren, was geprüft wird —
 * Baselines, Gate- und Linter-Konfiguration, CI-Workflows, Hook-Einstellungen.
 * Die Liste stammt aus derselben Quelle wie der Tamper-Check, damit es nicht
 * zwei Wahrheiten darüber gibt, was geschützt ist.
 *
 * Das ist die weiche Sicherung: Ein Agent könnte sie über die Shell umgehen.
 * Die harte Sicherung ist der Tamper-Check in CI. Diese hier existiert, damit
 * es gar nicht erst so weit kommt — und damit der Agent die Grenze erfährt,
 * bevor er Arbeit hineinsteckt.
 */
import { PROTECTED_PATHS } from '../guards/tamper.mjs'
import { findProjectRoot, readHookInput, relativeToRoot } from './lib/hook-io.mjs'

const input = await readHookInput()
const filePath = input?.tool_input?.file_path
if (!filePath) process.exit(0)

const root = findProjectRoot(input.cwd ?? process.cwd())
if (!root) process.exit(0)

const relativePath = relativeToRoot(filePath, root)
if (!relativePath) process.exit(0)

const hit = PROTECTED_PATHS.find(({ pattern }) => pattern.test(relativePath))
if (!hit) process.exit(0)

const reason =
  `${relativePath} ist geschützt (${hit.label}) und wird nicht vom Agenten geändert.\n\n` +
  `Wenn die Änderung wirklich nötig ist, beschreibe dem Menschen, was du ändern möchtest ` +
  `und warum — die Entscheidung darüber liegt bei ihm. Nutze keinen Umweg über die Shell.`

// permissionDecision ist der Weg, der die Begründung sauber an den Agenten
// weitergibt; Exit 2 täte es auch, wäre aber gröber.
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  })
)
process.exit(0)
