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
 *
 * WARUM DIESER HOOK KEINE RICHTUNG KENNT
 *
 * Der Tamper-Check unterscheidet bei Baselines seit v0.2.7 die Richtung: eine
 * Änderung, die nur entfernt, ist dort kein Fund (guards/tamper.mjs,
 * `baselineOnlyShrinks`). Dieser Hook macht das bewusst NICHT mit, obwohl die
 * Information vorläge — `tool_input` trägt bei Edit `old_string`/`new_string`
 * und bei Write den ganzen `content`.
 *
 * Der Grund: Für das Schrumpfen gibt es ein Werkzeug, `quality prune`. Es
 * fragt den Analysator, WELCHE Einträge tot sind, und kann konstruktionsbedingt
 * nur entfernen. Ein Hand-Edit kann beides nicht zusichern: „entfernt nur"
 * heisst nicht „entfernt die richtigen". Ein richtungsabhängiger Hook wäre ein
 * zweiter, ungeprüfter Weg an derselben Datei — mehr Fläche, kein Gewinn.
 * Das Kommando deckt beide Alltagsfälle ab, das Entfernen und das Senken des
 * Zählers; ein Rest, den nur ein Hand-Edit löst, bleibt nicht übrig.
 *
 * Statt der Lockerung nennt die Ablehnung deshalb den vorgesehenen Weg.
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

// Bei einer Baseline gibt es einen vorgesehenen Weg. Ihn hier zu nennen ist
// der Unterschied zwischen einer Sperre und einer Sackgasse: der Agent soll
// nicht den Menschen rufen, wo ein Kommando die Arbeit erledigt.
const wayOut = hit.shrinkOnly
  ? `Willst du Einträge ENTFERNEN, für die es keinen Fehler mehr gibt, nimm das Werkzeug:\n` +
    `    quality prune            (mit --dry-run erst zeigen, was wegfällt)\n` +
    `Es entfernt genau die Einträge, die der Analysator als unerfüllt meldet, und ` +
    `senkt zu hohe Zähler. Wachsen kann es nicht. Dieser Lauf über die Shell ist ` +
    `kein Umweg um den Hook, sondern der vorgesehene Weg.\n\n` +
    `Für alles andere an dieser Datei — einen Eintrag HINZUFÜGEN, sie umformatieren — ` +
    `beschreibe dem Menschen, was du ändern möchtest und warum.`
  : `Wenn die Änderung wirklich nötig ist, beschreibe dem Menschen, was du ändern möchtest ` +
    `und warum — die Entscheidung darüber liegt bei ihm. Nutze keinen Umweg über die Shell.`

const reason = `${relativePath} ist geschützt (${hit.label}) und wird nicht vom Agenten geändert.\n\n${wayOut}`

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
