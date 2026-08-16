/**
 * Stufen und Argumentauswertung des Runners.
 *
 * Eigenes Modul, weil bin/quality ein ausführbares Skript ist: wer es
 * importiert, startet sofort main(). Hier lässt sich prüfen, was die
 * Kommandozeile bedeutet, ohne einen Lauf auszulösen.
 */

/** Die Prüfschritte, in der Reihenfolge, in der sie laufen. */
export const VERBS = ['fmt', 'lint', 'types', 'test', 'build']

/**
 * Was --only kennt. "tamper" ist kein Schritt eines Stacks, sondern ein
 * Nachlauf über den Diff — für --only zählt es trotzdem mit, sonst liesse
 * sich eine Stufe nicht auf ihren statischen Teil beschränken, ohne den
 * Tamper-Check gleich mit zu verlieren.
 */
export const ONLY_NAMES = [...VERBS, 'tamper']

export const STAGES = {
  fix: { verbs: ['fmt', 'lint'], changedOnly: true, check: false, tamper: false },
  fast: { verbs: ['fmt', 'lint', 'types'], changedOnly: true, check: false, tamper: true },
  task: { verbs: ['fmt', 'lint', 'types', 'test'], changedOnly: false, check: true, tamper: true },
  full: { verbs: ['fmt', 'lint', 'types', 'test', 'build'], changedOnly: false, check: true, tamper: true },
  tamper: { verbs: [], changedOnly: false, check: true, tamper: true },
}

export const COMMANDS = ['audit', 'init']

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
    throw new Error(`--only kennt "${unknown.join('", "')}" nicht. Erlaubt sind: ${ONLY_NAMES.join(', ')}.`)
  }
  return names
}

export function parseArgs(argv) {
  const options = {
    stage: null,
    files: null,
    only: null,
    base: null,
    all: false,
    quiet: false,
    help: false,
    json: false,
    out: null,
    secrets: true,
    from: null,
    dryRun: false,
    force: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') options.help = true
    else if (arg === '--all') options.all = true
    else if (arg === '--quiet') options.quiet = true
    else if (arg === '--json') options.json = true
    else if (arg === '--no-secrets') options.secrets = false
    else if (arg === '--dry-run') options.dryRun = true
    else if (arg === '--force') options.force = true
    else if (arg === '--files') options.files = (argv[++i] ?? '').split(',').filter(Boolean)
    else if (arg.startsWith('--files=')) options.files = arg.slice(8).split(',').filter(Boolean)
    else if (arg === '--only') options.only = parseOnly(argv[++i])
    else if (arg.startsWith('--only=')) options.only = parseOnly(arg.slice(7))
    else if (arg === '--base') options.base = argv[++i] ?? null
    else if (arg.startsWith('--base=')) options.base = arg.slice(7)
    else if (arg === '--out') options.out = argv[++i] ?? null
    else if (arg.startsWith('--out=')) options.out = arg.slice(6)
    else if (arg === '--from') options.from = argv[++i] ?? null
    else if (arg.startsWith('--from=')) options.from = arg.slice(7)
    else if (arg.startsWith('-')) throw new Error(`Unbekannte Option "${arg}". "quality --help" zeigt alle an.`)
    else if (!options.stage) options.stage = arg
    else throw new Error(`Unerwartetes Argument "${arg}".`)
  }
  return options
}

/**
 * Was von einer Stufe übrig bleibt, nachdem --only angewandt wurde.
 * Ohne --only bleibt die Stufe, wie sie ist.
 */
export function planFor(stage, only) {
  if (!only) return { verbs: stage.verbs, tamper: stage.tamper }
  return {
    verbs: stage.verbs.filter((v) => only.includes(v)),
    tamper: stage.tamper && only.includes('tamper'),
  }
}
