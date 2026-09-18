/**
 * Führt das Schrumpfen der PHPStan-Baseline aus: startet den Analysator,
 * wertet seinen Bericht aus, schreibt die Datei.
 *
 * Die Entscheidungen stehen in lib/baseline.mjs und sind dort ohne PHPStan
 * prüfbar. Hier liegt nur, was die Umgebung berührt.
 *
 * Warum ein Kommando und nicht ein Handgriff des Agenten: `phpstan-baseline.neon`
 * ist ein geschützter Pfad, den der PreToolUse-Hook gegen Edit und Write sperrt.
 * Dieses Kommando läuft über die Shell und wird vom Hook darum nicht erfasst.
 * Das ist kein Umweg, sondern der vorgesehene Weg — weil das Kommando
 * konstruktionsbedingt nur schrumpfen kann und den Analysator fragt, welche
 * Einträge tot sind. Ein Hand-Edit kann beides nicht zusichern.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { applyPrune, parseBaseline, planPrune, readIgnoreFindings } from './baseline.mjs'
import { c } from './run.mjs'
import { findBinary, missingToolHint } from './tools.mjs'

const BASELINE_FILE = 'phpstan-baseline.neon'

/** Die PHPStan-Konfiguration einer Komponente, in derselben Reihenfolge wie im Stack. */
const CONFIG_FILES = ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon']

/**
 * Stacks mit PHPStan — nur sie haben eine phpstan-baseline.neon.
 * Kommt ein weiterer PHP-Stack zu KNOWN_STACKS (lib/config.mjs) hinzu,
 * gehört er auch hierher.
 */
const PHP_STACKS = ['laravel', 'php']

const ANALYSE_TIMEOUT_MS = 10 * 60 * 1000

/** Baseline-Dateien der konfigurierten PHP-Komponenten. */
export function baselineTargets(config) {
  const targets = []
  for (const component of config.components) {
    if (!PHP_STACKS.includes(component.stack)) continue
    const dir = resolve(config.root, component.path)
    const file = join(dir, BASELINE_FILE)
    if (!existsSync(file)) continue
    targets.push({ component, dir, file })
  }
  return targets
}

/**
 * Wie in lib/audit-run.mjs: Werkzeuge schreiben gelegentlich eine Warnung vor
 * das JSON. Bewusst eine eigene Kopie — das Schrumpfen soll nicht am
 * Audit-Lauf hängen, der ein ganz anderes Gewicht hat.
 */
function parseJsonLoose(text) {
  const start = text.indexOf('{')
  if (start === -1) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return null
  }
}

/**
 * Baut den PHPStan-Lauf für eine Komponente.
 *
 * Zwei Eigenschaften des Laufs tragen die Sicherheit des Kommandos:
 *
 * Er umfasst IMMER das ganze Projekt. Eine Analyse einzelner Dateien würde
 * jeden Eintrag außerhalb davon als unerfüllt melden — und damit lebende
 * Einträge entfernen.
 *
 * Er nimmt dieselbe phpstan.neon und dasselbe Level wie `quality task`. Was
 * hier als tot gilt, gilt also auch im Gate als tot; die beiden können nicht
 * auseinanderlaufen.
 */
export function makeAnalyser(target, { root, level }) {
  const tool = findBinary('phpstan', { dir: target.dir, root, kind: 'php' })
  if (!tool) return { analyse: null, hint: missingToolHint('phpstan', 'php') }

  const configFile = CONFIG_FILES.find((f) => existsSync(join(target.dir, f)))
  if (!configFile) {
    return { analyse: null, hint: `keine ${CONFIG_FILES[0]} in "${target.component.path}"` }
  }

  const analyse = () => {
    const run = spawnSync(
      tool,
      [
        'analyse',
        '--configuration',
        configFile,
        '--level',
        String(level),
        '--error-format',
        'json',
        '--memory-limit',
        '2G',
        '--no-progress',
      ],
      {
        cwd: target.dir,
        encoding: 'utf8',
        timeout: ANALYSE_TIMEOUT_MS,
        maxBuffer: 128 * 1024 * 1024,
      }
    )
    return parseJsonLoose(run.stdout ?? '')
  }

  return { analyse, hint: null }
}

/**
 * Schrumpft EINE Baseline.
 *
 * `analyse` liefert den JSON-Bericht von PHPStan oder null. Geschrieben wird
 * nur, wenn der Bericht da ist, keine Sperre vorliegt und sich etwas ändert.
 */
export function pruneBaselineFile(target, { analyse, dryRun = false }) {
  const before = readFileSync(target.file, 'utf8')
  const parsed = parseBaseline(before)
  const report = analyse()

  if (!report) {
    return {
      file: target.file,
      dropped: 0,
      lowered: 0,
      kept: parsed.entries.length,
      unclaimed: [],
      blockers: ['PHPStan lieferte keinen JSON-Bericht — der Lauf ist gescheitert.'],
      written: false,
    }
  }

  const plan = planPrune(parsed, readIgnoreFindings(report), { dir: target.dir })
  const after = applyPrune(parsed, plan)
  const written = !dryRun && plan.blockers.length === 0 && after !== before
  if (written) writeFileSync(target.file, after)

  return {
    file: target.file,
    dropped: plan.drop.length,
    lowered: plan.lower.length,
    kept: parsed.entries.length - plan.drop.length,
    unclaimed: plan.unclaimed,
    blockers: plan.blockers,
    written,
  }
}

/**
 * Das Kommando `quality prune`.
 *
 * Rückgabe ist der Exit-Code: 0, wenn der Lauf sauber war — auch dann, wenn
 * nichts zu entfernen war. 2, wenn eine Baseline nicht bewertet werden konnte.
 * Ein noch offener echter PHPStan-Fehler ist KEIN Fehler dieses Kommandos;
 * dafür ist `quality task` da.
 */
export function runPrune(config, { dryRun = false, quiet = false } = {}) {
  const write = (s) => process.stdout.write(s)
  const targets = baselineTargets(config)

  if (targets.length === 0) {
    write(c.dim(`Keine ${BASELINE_FILE} in den konfigurierten Komponenten — nichts zu schrumpfen.\n`))
    return 0
  }

  let code = 0
  let dropped = 0
  let lowered = 0

  for (const target of targets) {
    const label = relative(config.root, target.file)
    const { analyse, hint } = makeAnalyser(target, { root: config.root, level: target.component.phpstanLevel })
    if (!analyse) {
      write(c.red(`✗ ${label}: ${hint}\n`))
      code = 2
      continue
    }

    if (!quiet) write(c.dim(`phpstan level ${target.component.phpstanLevel} (${target.component.path}) …\n`))
    const result = pruneBaselineFile(target, { analyse, dryRun })

    if (result.blockers.length > 0) {
      write(c.red(`✗ ${label}: nicht bewertbar, deshalb unverändert.\n`))
      for (const blocker of result.blockers) write(`      ${c.dim(String(blocker).slice(0, 200))}\n`)
      code = 2
      continue
    }

    dropped += result.dropped
    lowered += result.lowered

    if (result.dropped === 0 && result.lowered === 0) {
      write(c.green(`✓ ${label}: kein toter Eintrag, ${result.kept} bleiben.\n`))
    } else {
      const was = [
        result.dropped > 0 ? `${result.dropped} Eintrag/Einträge entfernt` : null,
        result.lowered > 0 ? `${result.lowered} Zähler gesenkt` : null,
      ]
        .filter(Boolean)
        .join(', ')
      write(`${dryRun ? c.yellow('~') : c.green('✓')} ${label}: ${was}, ${result.kept} bleiben.\n`)
    }

    // Eine Ausnahme kann auch direkt in der phpstan.neon stehen. Sie gehört
    // nicht zur Baseline und wird hier nicht angefasst — aber sie ist derselbe
    // Drift, und wer ihn nicht erfährt, sucht später den roten Lauf.
    if (result.unclaimed.length > 0 && !quiet) {
      write(
        c.dim(
          `      ${result.unclaimed.length} unerfüllte Ausnahme(n) ausserhalb der Baseline — ` +
            `sie stehen in der phpstan.neon und gehören von Hand geprüft.\n`
        )
      )
    }
  }

  if (dryRun && (dropped > 0 || lowered > 0)) {
    write(c.dim('\n--dry-run: nichts geschrieben. Ohne die Option wird die Baseline geschrumpft.\n'))
  }
  return code
}
