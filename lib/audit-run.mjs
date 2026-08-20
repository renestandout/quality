/**
 * Führt die Bestandsaufnahme aus: startet Werkzeuge, sammelt Fakten.
 *
 * Der Audit blockiert nie und ändert nichts. Er misst den Ist-Zustand eines
 * Repositories und leitet daraus einen Vorschlag für die quality.yml ab —
 * das Werkzeug, mit dem ein bestehendes Projekt überhaupt erst einsteigt.
 */
import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  countTscErrors,
  jsAuditCommand,
  parseBaselineCounts,
  parseComposerAudit,
  parseNpmAudit,
  parsePipAudit,
  parsePhpstanJson,
  recommendLevel,
  recommendPhpstanLevel,
  scanHygiene,
  shortVersion,
} from './audit.mjs'
import { loadConfig } from './config.mjs'
import { PHP_ANALYSE_PATHS, detectComponents } from './detect.mjs'
import { c } from './run.mjs'
import { componentsForWiring, inspectWiring } from './wiring.mjs'
import { SOURCE_FILE, VENDOR_PATH, isTestFile } from '../guards/tamper.mjs'
import { JS_LOCKFILES, findBinary } from './tools.mjs'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const STEP_TIMEOUT_MS = 5 * 60 * 1000

/** Startet ein Werkzeug und gibt die Ausgabe zurück, ohne bei Exit≠0 zu werfen. */
function capture(cmd, args, { cwd, timeout = STEP_TIMEOUT_MS, env } = {}) {
  const result = spawnSync(cmd, args, {
    cwd,
    encoding: 'utf8',
    timeout,
    maxBuffer: 128 * 1024 * 1024,
    env: env ? { ...process.env, ...env } : process.env,
  })
  return {
    code: result.status ?? (result.error ? 127 : 1),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    output: `${result.stdout ?? ''}${result.stderr ?? ''}`,
    failed: Boolean(result.error),
    timedOut: result.error?.code === 'ETIMEDOUT',
  }
}

function parseJsonLoose(text) {
  // Werkzeuge schreiben gelegentlich eine Warnung vor das JSON.
  const start = text.indexOf('{')
  if (start === -1) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return null
  }
}

function hasCommand(name) {
  return spawnSync('sh', ['-c', `command -v ${name}`], { encoding: 'utf8' }).status === 0
}

/* ── PHP ─────────────────────────────────────────────────────────────── */

const PHP_PATHS = PHP_ANALYSE_PATHS

function larastanExtension(dir, root) {
  for (const base of [dir, root]) {
    const file = join(base, 'vendor', 'larastan', 'larastan', 'extension.neon')
    if (existsSync(file)) return file
  }
  return null
}

/**
 * Erzeugt eine Messkonfiguration ausserhalb des Projekts.
 *
 * Bewusst nicht im Repository: eine Bestandsaufnahme darf keine Spuren
 * hinterlassen, auch nicht, wenn sie mittendrin abgebrochen wird. Deshalb
 * stehen die Pfade darin absolut.
 */
function writeProbeConfig(component, root) {
  const paths = PHP_PATHS.map((p) => join(component.dir, p)).filter((p) => existsSync(p))
  if (paths.length === 0) return null
  const extension = larastanExtension(component.dir, root)
  const dir = mkdtempSync(join(tmpdir(), 'quality-audit-'))

  const includes = []
  // Larastan zuerst, damit die Parameter der Basiskonfiguration danach gelten.
  if (extension) includes.push(extension)
  // Gemessen wird mit der Konfiguration, die später auch im Betrieb gilt —
  // sonst sagt die Zahl etwas über einen Zustand aus, den es nie geben wird.
  const base = join(PKG_ROOT, 'configs', 'phpstan', 'base.neon')
  if (existsSync(base)) includes.push(base)

  const lines = []
  if (includes.length) {
    lines.push('includes:')
    for (const include of includes) lines.push(`    - ${include}`)
  }
  lines.push('parameters:', '    paths:')
  for (const p of paths) lines.push(`        - ${p}`)
  if (component.facts.php) lines.push(`    phpVersion: ${phpVersionId(component.facts.php)}`)
  // Der Cache gehört ins temporäre Verzeichnis: eine Bestandsaufnahme darf
  // kein .phpstan-cache im geprüften Projekt hinterlassen.
  lines.push(`    tmpDir: ${join(dir, 'cache')}`)

  const file = join(dir, 'probe.neon')
  writeFileSync(file, lines.join('\n') + '\n')
  return { file, dir, paths, larastan: Boolean(extension) }
}

/** PHPStan erwartet die Version als Zahl: 8.3 → 80300. */
function phpVersionId(constraint) {
  const version = shortVersion(constraint)
  const [major, minor = '0'] = String(version).split('.')
  const maj = Number.parseInt(major, 10)
  const min = Number.parseInt(minor, 10)
  if (!Number.isInteger(maj)) return null
  return maj * 10000 + (Number.isInteger(min) ? min : 0) * 100
}

/**
 * Sucht das höchste Level, auf dem die Komponente heute fehlerfrei ist.
 *
 * Erst Level 9 — ein sauberes Projekt ist damit nach einem Lauf fertig. Sonst
 * binäre Suche, das kostet vier weitere Läufe statt zehn. Der Kandidat 5 wird
 * am Ende sicher gemessen, weil er die häufigste Empfehlung ist und die Liste
 * der schwersten Dateien liefert.
 */
function measurePhpstan(component, root, { log }) {
  // Ohne Messung gibt es trotzdem eine Empfehlung — eine vorsichtige, klar als
  // ungemessen markierte. Sie einfach wegzulassen wäre der gefährlichere Weg:
  // die Konfiguration liefe dann still auf dem Standardwert ohne Baseline.
  const unmeasured = (hint) => ({ available: false, hint, recommendation: recommendPhpstanLevel([]) })

  const tool = findBinary('phpstan', { dir: component.dir, root, kind: 'php' })
  if (!tool) {
    return unmeasured('PHPStan ist nicht installiert: composer require --dev larastan/larastan')
  }
  const probe = writeProbeConfig(component, root)
  if (!probe) return unmeasured('kein analysierbares Verzeichnis gefunden (app/, src/ …)')

  const measurements = []
  const details = new Map()

  const measure = (level) => {
    const known = measurements.find((m) => m.level === level)
    if (known) return known
    log(`  phpstan level ${level} …`)
    const run = capture(
      tool,
      [
        'analyse',
        '--configuration',
        probe.file,
        '--level',
        String(level),
        '--error-format',
        'json',
        '--memory-limit',
        '2G',
        '--no-progress',
      ],
      { cwd: component.dir }
    )
    const json = parseJsonLoose(run.stdout)
    if (!json) {
      const entry = { level, errors: null, failed: true, output: run.output.trim().slice(-800) }
      measurements.push(entry)
      return entry
    }
    const parsed = parsePhpstanJson(json)
    details.set(level, { byFile: parsed.byFile, truncated: parsed.truncated })
    const entry = { level, errors: parsed.errors }
    measurements.push(entry)
    return entry
  }

  let recommendation
  let detail
  let complete = null
  try {
    const top = measure(9)
    if (!(top.errors === 0)) {
      let lo = 0
      let hi = 8
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2)
        const entry = measure(mid)
        if (entry.errors === 0) lo = mid + 1
        else hi = mid - 1
      }
      if (!measurements.some((m) => m.level === 5)) measure(5)
    }

    recommendation = recommendPhpstanLevel(measurements.filter((m) => Number.isInteger(m.errors)))
    detail = details.get(recommendation.phpstanLevel) ?? { byFile: [], truncated: false }
    // Nur wenn die Fundstellenliste gekappt ist, lohnt der Zusatzlauf.
    if (detail.truncated) {
      complete = baselineDistribution(probe, tool, component, recommendation.phpstanLevel, { log })
    }
  } finally {
    rmSync(probe.dir, { recursive: true, force: true })
  }

  const byFile = complete ?? detail.byFile
  const total = byFile.reduce((sum, f) => sum + f.errors, 0)

  return {
    available: true,
    // Nur bei Laravel ist eine fehlende Erweiterung ein Messfehler; bei
    // gewöhnlichem PHP-Code gibt es nichts zu erweitern.
    larastan: probe.larastan || component.stack !== 'laravel',
    measurements: measurements.sort((a, b) => a.level - b.level),
    recommendation,
    topFiles: byFile.slice(0, 5).map((f) => ({ file: relativeTo(component.dir, f.file), errors: f.errors })),
    topFilesTruncated: complete ? false : detail.truncated,
    affectedFiles: complete ? byFile.length : null,
    countedErrors: complete ? total : null,
  }
}

/**
 * Ermittelt die vollständige Verteilung der Fehler über die Dateien.
 *
 * Umweg über eine Probe-Baseline, weil PHPStans Agent-Format die
 * Fundstellenliste kappt. Die Datei landet im temporären Verzeichnis der
 * Messung und wird mit ihm gelöscht — das Projekt bleibt unberührt.
 */
function baselineDistribution(probe, tool, component, level, { log }) {
  log(`  Verteilung der Fehler auf Level ${level} …`)
  const file = join(probe.dir, 'baseline.neon')
  const run = capture(
    tool,
    [
      'analyse',
      '--configuration',
      probe.file,
      '--level',
      String(level),
      '--generate-baseline',
      file,
      '--allow-empty-baseline',
      '--memory-limit',
      '2G',
      '--no-progress',
    ],
    { cwd: component.dir }
  )
  if (!existsSync(file)) {
    log(`  (Verteilung nicht ermittelbar: ${run.output.trim().split('\n').pop() ?? 'kein Ergebnis'})`)
    return null
  }
  const counts = parseBaselineCounts(readFileSync(file, 'utf8'))
  // Pfade in der Baseline stehen relativ zu ihr — hier also zum tmp-Ordner.
  return counts.map((entry) => ({ file: resolve(probe.dir, entry.file), errors: entry.errors }))
}

function relativeTo(dir, file) {
  return file.startsWith(dir) ? file.slice(dir.length + 1) : file
}

function auditComposer(component) {
  if (!existsSync(join(component.dir, 'composer.lock'))) {
    return { available: false, hint: 'keine composer.lock' }
  }
  const run = capture('composer', ['audit', '--format=json', '--no-interaction'], { cwd: component.dir })
  const json = parseJsonLoose(run.stdout)
  if (!json) return { available: false, hint: run.output.trim().split('\n').pop() || 'composer audit lieferte kein JSON' }
  return { available: true, counts: parseComposerAudit(json) }
}

function auditPythonDependencies(component) {
  if (!hasCommand('pip-audit')) {
    return { available: false, hint: 'pip-audit nicht gefunden — installieren mit: pip install pip-audit' }
  }
  const run = capture('pip-audit', ['--format=json', '--progress-spinner=off'], { cwd: component.dir })
  const json = parseJsonLoose(run.stdout)
  if (!json) return { available: false, hint: run.output.trim().split('\n').pop() || 'pip-audit lieferte kein JSON' }
  return { available: true, tool: 'pip-audit', counts: parsePipAudit(json) }
}

function auditJsDependencies(component, root) {
  const present = JS_LOCKFILES.filter((f) => existsSync(join(component.dir, f)))
  // Nur unterhalb der Wurzel gibt es einen Unterschied zwischen "hier" und
  // "dort". lib/detect.mjs setzt fuer die Wurzelkomponente genau den Pfad ".".
  const rootLockfiles =
    component.path === '.' ? [] : JS_LOCKFILES.filter((f) => existsSync(join(root, f)))
  const plan = jsAuditCommand(present, { componentPath: component.path, rootLockfiles })
  if (plan.hint) return { available: false, hint: plan.hint }

  const run = capture(plan.cmd, plan.args, { cwd: component.dir })
  const json = parseJsonLoose(run.stdout)
  if (!json) {
    // Fehlt das Werkzeug ganz, sagt das mehr als "lieferte kein JSON": ein
    // pnpm-Projekt auf einer Maschine ohne pnpm ist der haeufigere Fall.
    const hint = run.failed
      ? `${plan.cmd} nicht gefunden — der Dependency-Audit braucht das Werkzeug des Lockfiles`
      : `${plan.cmd} audit lieferte kein JSON (offline?)`
    return { available: false, hint }
  }
  return { available: true, tool: plan.cmd, counts: parseNpmAudit(json) }
}

/* ── Adapter-gestützte Messungen ─────────────────────────────────────── */

/**
 * Führt einen Schritt eines Stack-Adapters aus.
 *
 * Gemessen wird immer gegen `strict`: nur so zählen Linter-Warnungen als
 * Fundstellen. Ein Audit, der die weichere Einstellung misst, meldet ein
 * sauberes Projekt und verschweigt genau das, was der Rollout wissen muss.
 */
function runAdapterStep(stack, verb, component, config, { log }) {
  const ctx = {
    dir: component.dir,
    root: config.root,
    component: { ...component, kind: stack.kind, phpstanLevel: 5 },
    config: { ...config, level: 'strict' },
    files: null,
    check: true,
    full: true,
  }
  const step = stack[verb]?.(ctx)
  if (!step) return null
  if (step.skip) return { skipped: true, reason: step.skip }
  log(`  ${step.name} …`)
  const run = capture(step.cmd, step.args ?? [], { cwd: step.cwd })
  return { clean: run.code === 0, code: run.code, output: run.output.trim().slice(-4000) }
}

/* ── Hygiene und Tests ───────────────────────────────────────────────── */

// Welche Datei Quellcode ist und welche ein Test: dieselben Muster wie im
// Tamper-Check, importiert statt nachgebaut. Zwei Listen bedeuten sonst, dass
// der Audit etwas anderes zaehlt als das Gate spaeter prueft — bei Python war
// genau das der Fall: die lokale Liste kannte .py nicht, und der Bericht
// meldete "0 Quelldateien" fuer ein Projekt voller Python.
const MAX_FILE_BYTES = 512 * 1024

function trackedFiles(root, relPath) {
  try {
    const args = ['ls-files', '-z']
    if (relPath && relPath !== '.') args.push('--', relPath)
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0')
      .filter(Boolean)
  } catch {
    return []
  }
}

function collectHygiene(root, component, ignorePaths = []) {
  const files = []
  let tests = 0
  for (const path of trackedFiles(root, component.path)) {
    if (!SOURCE_FILE.test(path) || VENDOR_PATH.test(path)) continue
    // Dieselbe Ausnahmeliste wie der Tamper-Check: was dort nicht bewertet
    // wird, ist auch hier kein Altbestand — etwa Regelwerk, das die gesuchten
    // Muster als Text enthält.
    if (ignorePaths.some((prefix) => path.startsWith(prefix))) continue
    const isTest = isTestFile(path)
    if (isTest) tests++
    try {
      const full = join(root, path)
      const content = readFileSync(full, 'utf8')
      if (content.length > MAX_FILE_BYTES) continue
      files.push({ path, content, isTest })
    } catch {
      // Unlesbare Datei übergehen wir still — sie sagt nichts über Qualität.
    }
  }
  return { ...scanHygiene(files), sourceFiles: files.length, testFiles: tests }
}

/* ── Repository ──────────────────────────────────────────────────────── */

/**
 * Secret-Scan über die gesamte Historie.
 *
 * Das ist die eine Prüfung, die ein Diff-Gate grundsätzlich nicht leisten
 * kann: ein Schlüssel, der vor zwei Jahren committet und später gelöscht
 * wurde, steht weiterhin im Repository und ist weiterhin gültig.
 */
function scanSecrets(root, { log }) {
  if (!hasCommand('gitleaks')) {
    return { available: false, hint: 'gitleaks nicht installiert: brew install gitleaks' }
  }
  log('  gitleaks über die gesamte Historie …')
  const dir = mkdtempSync(join(tmpdir(), 'quality-gitleaks-'))
  const report = join(dir, 'report.json')
  try {
    // Neuere Versionen kennen "git", ältere "detect" — beides probieren.
    let run = capture('gitleaks', ['git', '--no-banner', '--report-format', 'json', '--report-path', report, root], { cwd: root })
    if (run.code !== 0 && !existsSync(report)) {
      run = capture('gitleaks', ['detect', '--no-banner', '--source', root, '--report-format', 'json', '--report-path', report], { cwd: root })
    }
    if (!existsSync(report)) {
      return { available: false, hint: run.output.trim().split('\n').pop() || 'gitleaks lieferte keinen Bericht' }
    }
    const findings = JSON.parse(readFileSync(report, 'utf8') || '[]')
    const byRule = new Map()
    for (const finding of findings) {
      const key = finding.RuleID ?? finding.Description ?? 'unbekannt'
      byRule.set(key, (byRule.get(key) ?? 0) + 1)
    }
    return {
      available: true,
      count: findings.length,
      rules: [...byRule.entries()].map(([rule, count]) => ({ rule, count })).sort((a, b) => b.count - a.count),
    }
  } catch (err) {
    return { available: false, hint: err.message }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function repoFacts(root) {
  const git = (args, fallback = null) => {
    try {
      return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim()
    } catch {
      return fallback
    }
  }
  let workflows = []
  const dir = join(root, '.github', 'workflows')
  if (existsSync(dir)) {
    try {
      workflows = readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
    } catch {
      /* egal */
    }
  }
  return {
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    commits: Number(git(['rev-list', '--count', 'HEAD'], '0')),
    workflows,
    hasQualityConfig: ['quality.yml', 'quality.yaml'].some((f) => existsSync(join(root, f))),
  }
}

/* ── Orchestrierung ──────────────────────────────────────────────────── */

/**
 * Übernimmt tamper.ignore aus einer vorhandenen quality.yml.
 * Läuft der Audit vor dem Onboarding, gibt es sie noch nicht — dann ist die
 * Liste leer, und eine fehlerhafte Konfiguration darf den Audit nicht stoppen.
 */
function existingIgnorePaths(root) {
  try {
    return loadConfig(root).tamperIgnore ?? []
  } catch {
    return []
  }
}

/**
 * Dasselbe für `configs:` — womit ein Projekt eine bewusst eigene Konfiguration
 * dauerhaft von der Einbindungsprüfung ausnimmt.
 */
function declaredConfigs(root) {
  try {
    return loadConfig(root).configs ?? {}
  } catch {
    return {}
  }
}

/** Und die Komponenten — siehe componentsForWiring in lib/wiring.mjs. */
function declaredComponents(root) {
  try {
    return loadConfig(root).components ?? []
  } catch {
    return []
  }
}

async function loadStack(name) {
  const file = join(PKG_ROOT, 'stacks', `${name}.mjs`)
  if (!existsSync(file)) return null
  return (await import(file)).default
}

export async function runAudit(root, { quiet = false, secrets = true } = {}) {
  const log = (message) => {
    if (!quiet) process.stderr.write(c.dim(`${message}\n`))
  }

  log('Komponenten suchen …')
  const ignorePaths = existingIgnorePaths(root)
  const detected = detectComponents(root)
  if (detected.length === 0) {
    return { root, repo: repoFacts(root), components: [], wiring: [], recommendation: null }
  }

  const config = { root, level: 'strict', baseline: false, components: [] }
  const components = []

  for (const component of detected) {
    log(`${c.bold(component.path)} (${component.stack})`)
    const stack = await loadStack(component.stack)
    const entry = {
      path: component.path,
      stack: component.stack,
      facts: component.facts,
      hygiene: collectHygiene(root, component, ignorePaths),
    }

    if (stack?.kind === 'php') {
      entry.phpstan = measurePhpstan(component, root, { log })
      entry.deps = auditComposer(component)
      entry.fmt = runAdapterStep(stack, 'fmt', component, config, { log })
    } else if (stack) {
      entry.types = runAdapterStep(stack, 'types', component, config, { log })
      entry.lint = runAdapterStep(stack, 'lint', component, config, { log })
      entry.fmt = runAdapterStep(stack, 'fmt', component, config, { log })
      entry.deps = stack.kind === 'py' ? auditPythonDependencies(component) : auditJsDependencies(component, root)
    }

    components.push(entry)
  }

  const repo = repoFacts(root)
  repo.secrets = secrets ? scanSecrets(root, { log }) : { available: false, hint: 'übersprungen (--no-secrets)' }

  // Einbindung der Paket-Konfigurationen: eigener Abschnitt, keine Messung.
  // Eingebunden oder nicht ist eine Tatsache, die man ablesen kann.
  const wiring = inspectWiring({
    components: componentsForWiring(declaredComponents(root), detected),
    read: (path) => {
      const file = join(root, path)
      return existsSync(file) ? readFileSync(file, 'utf8') : null
    },
    configs: declaredConfigs(root),
  })

  const level = recommendLevel(components)
  const recommendation = {
    level: level.level,
    levelReason: level.reason,
    components: components.map((comp) => ({
      path: comp.path,
      stack: comp.stack,
      // Die PHP-Version gehört nur an eine PHP-Komponente. Ein Node-Paket kann
      // eine composer.json haben, ohne dass "php:" dort etwas zu suchen hätte.
      php: ['laravel', 'php'].includes(comp.stack) && comp.facts.php ? shortVersion(comp.facts.php) : null,
      phpstanLevel: comp.phpstan?.recommendation?.phpstanLevel ?? null,
      baseline: comp.phpstan?.recommendation?.baseline ?? false,
      reason: comp.phpstan?.recommendation?.reason ?? null,
      // Steht im YAML als Kommentar: eine geratene Zahl darf nicht aussehen
      // wie eine gemessene.
      note: comp.phpstan && comp.phpstan.recommendation.measured === false ? 'ungemessen, siehe Bericht' : null,
    })),
  }

  return { root, repo, components, wiring, recommendation }
}
