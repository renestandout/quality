/**
 * Stufen und Argumentauswertung des Runners.
 *
 * Eigenes Modul, weil bin/quality ein ausführbares Skript ist: wer es
 * importiert, startet sofort main(). Hier lässt sich prüfen, was die
 * Kommandozeile bedeutet, ohne einen Lauf auszulösen.
 */

/** @import { Verb } from './types.mjs' */

/**
 * Die Prüfschritte, in der Reihenfolge, in der sie laufen.
 *
 * @type {Verb[]}
 */
export const VERBS = ['fmt', 'lint', 'types', 'test', 'build']

/**
 * Was --only kennt. "tamper" ist kein Schritt eines Stacks, sondern ein
 * Nachlauf über den Diff — für --only zählt es trotzdem mit, sonst liesse
 * sich eine Stufe nicht auf ihren statischen Teil beschränken, ohne den
 * Tamper-Check gleich mit zu verlieren.
 */
export const ONLY_NAMES = [...VERBS, 'tamper']

/**
 * @typedef {object} Stage
 * @property {Verb[]} verbs
 * @property {boolean} changedOnly
 * @property {boolean} check
 * @property {boolean} tamper
 */

/** @satisfies {Record<string, Stage>} */
export const STAGES = {
  fix: { verbs: ['fmt', 'lint'], changedOnly: true, check: false, tamper: false },
  fast: { verbs: ['fmt', 'lint', 'types'], changedOnly: true, check: false, tamper: true },
  task: { verbs: ['fmt', 'lint', 'types', 'test'], changedOnly: false, check: true, tamper: true },
  full: {
    verbs: ['fmt', 'lint', 'types', 'test', 'build'],
    changedOnly: false,
    check: true,
    tamper: true,
  },
  tamper: { verbs: [], changedOnly: false, check: true, tamper: true },
}

/**
 * Kommandos, die keine Prüfstufe sind: sie laufen ohne quality.yml (audit,
 * init, deploy-check) oder ändern eine Datei (prune) — beides passt nicht in
 * eine Stufe, die nur prüft.
 */
export const COMMANDS = ['audit', 'init', 'prune', 'deploy-check']

/**
 * @param {string | undefined} value
 * @returns {string[]}
 */
function parseOnly(value) {
  const names = (value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (names.length === 0) {
    throw new Error('--only erwartet mindestens einen Schritt, zum Beispiel --only fmt,lint,types.')
  }
  const unknown = names.filter((n) => !ONLY_NAMES.includes(n))
  if (unknown.length > 0) {
    throw new Error(
      `--only kennt "${unknown.join('", "')}" nicht. Erlaubt sind: ${ONLY_NAMES.join(', ')}.`,
    )
  }
  return names
}

/**
 * Ein leerer Wert wäre der gefährlichste Zustand: `base` bliebe falsy, der
 * Tamper-Check fiele in den lokalen Modus und meldete in CI grün, ohne einen
 * Commit gesehen zu haben. In einem Workflow entsteht das leicht — ein
 * Ausdruck, der für dieses Ereignis nichts liefert.
 *
 * @param {string | undefined} value
 * @returns {string}
 */
function parseBase(value) {
  const ref = (value ?? '').trim()
  if (!ref) throw new Error('--base erwartet eine Referenz, zum Beispiel --base origin/main.')
  return ref
}

/**
 * Eine Frist in ganzen Sekunden. Ein Tippfehler darf nicht still zu 0 werden:
 * dann wartete ein Deploy-Skript nicht und brach ab, ohne dass jemand sieht,
 * warum.
 *
 * @param {string | undefined} value
 * @returns {number}
 */
function parseWait(value) {
  const text = (value ?? '').trim()
  if (!/^\d+$/.test(text)) {
    throw new Error('--wait erwartet eine Frist in ganzen Sekunden, zum Beispiel --wait 900.')
  }
  return Number(text)
}

/**
 * @typedef {object} Options
 * @property {string | null} stage
 * @property {string[] | null} files
 * @property {string[] | null} only
 * @property {string | null} base
 * @property {boolean} all
 * @property {boolean} check
 * @property {boolean} quiet
 * @property {boolean} help
 * @property {boolean} json
 * @property {string | null} out
 * @property {boolean} secrets
 * @property {string | null} from
 * @property {boolean} dryRun
 * @property {boolean} force
 * @property {string | null} ref
 * @property {number} wait
 */

/**
 * @param {string[]} argv
 * @returns {Options}
 */
export function parseArgs(argv) {
  /** @type {Options} */
  const options = {
    stage: null,
    files: null,
    only: null,
    base: null,
    all: false,
    check: false,
    quiet: false,
    help: false,
    json: false,
    out: null,
    secrets: true,
    from: null,
    dryRun: false,
    force: false,
    ref: null,
    wait: 0,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = /** @type {string} */ (argv[i])
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--all') options.all = true
    else if (arg === '--check') options.check = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--json') options.json = true
    else if (arg === '--no-secrets') options.secrets = false
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--files') options.files = (argv[++i] ?? '').split(',').filter(Boolean)
    else if (arg.startsWith('--files=')) options.files = arg.slice(8).split(',').filter(Boolean)
    else if (arg === '--only') options.only = parseOnly(argv[++i])
    else if (arg.startsWith('--only=')) options.only = parseOnly(arg.slice(7))
    else if (arg === '--base') options.base = parseBase(argv[++i])
    else if (arg.startsWith('--base=')) options.base = parseBase(arg.slice(7))
    else if (arg === '--out') options.out = argv[++i] ?? null
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg === '--from') options.from = argv[++i] ?? null
    else if (arg.startsWith('--from=')) options.from = arg.slice(7)
    else if (arg === '--wait') options.wait = parseWait(argv[++i])
    else if (arg.startsWith('--wait=')) options.wait = parseWait(arg.slice(7))
    else if (arg.startsWith('-'))
      throw new Error(`Unbekannte Option "${arg}". "quality --help" zeigt alle an.`)
    else if (!options.stage) options.stage = arg
    // Nur deploy-check nimmt ein zweites Argument. Bei einer Prüfstufe wäre es
    // ein Tippfehler, der still verschwände.
    else if (options.stage === 'deploy-check' && options.ref === null) options.ref = arg
    else throw new Error(`Unerwartetes Argument "${arg}".`)
  }
  // Bei einer Prüfstufe wäre --wait wirkungslos. Ein Tippfehler soll auffallen.
  if (options.wait > 0 && options.stage !== 'deploy-check') {
    throw new Error('--wait gibt es nur für deploy-check.')
  }
  return options
}

/**
 * Was von einer Stufe übrig bleibt, nachdem --only angewandt wurde.
 * Ohne --only bleibt die Stufe, wie sie ist.
 *
 * @param {Stage} stage
 * @param {string[] | null} only
 * @returns {{ verbs: Verb[], tamper: boolean }}
 */
export function planFor(stage, only) {
  if (!only) return { verbs: stage.verbs, tamper: stage.tamper }
  return {
    verbs: stage.verbs.filter((v) => only.includes(v)),
    tamper: stage.tamper && only.includes('tamper'),
  }
}
