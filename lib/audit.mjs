/**
 * Auswertungslogik der Bestandsaufnahme.
 *
 * Hier steht ausschliesslich, wie aus Werkzeug-Ausgaben Zahlen und aus Zahlen
 * eine Empfehlung wird — ohne Prozesse zu starten oder Dateien zu lesen. Die
 * Ausführung liegt in `audit-run.mjs`, damit diese Regeln testbar bleiben.
 */
import { LINE_RULES } from '../guards/tamper.mjs'
import { JS_LOCKFILES, packageManagerFrom } from './tools.mjs'

export const SEVERITIES = ['critical', 'high', 'moderate', 'low']

const emptySeverities = () => ({ critical: 0, high: 0, moderate: 0, low: 0, unknown: 0, total: 0 })

/**
 * `npm audit --json` meldet die Zählung fertig unter metadata.vulnerabilities.
 * Ältere npm-Versionen kennen dort kein "moderate", deshalb wird jeder
 * Schlüssel einzeln übernommen statt das Objekt zu übernehmen.
 */
export function parseNpmAudit(json) {
  const counts = emptySeverities()
  const vulns = json?.metadata?.vulnerabilities
  if (!vulns) return counts
  for (const severity of SEVERITIES) counts[severity] = Number(vulns[severity] ?? 0)
  counts.total = SEVERITIES.reduce((sum, s) => sum + counts[s], 0)
  return counts
}

/**
 * Welches Werkzeug den Dependency-Audit im JS-Ökosystem übernimmt.
 *
 * Das Lockfile entscheidet, nicht die Gewohnheit: `npm audit` gegen eine
 * pnpm-Installation misst nichts Brauchbares. Welches Lockfile welches
 * Werkzeug bedeutet, steht in `packageManagerFrom` — dieselbe Regel bestimmt,
 * womit die Projekt-Skripte laufen. pnpm gibt bei `--json` dieselbe Form aus
 * wie npm — `metadata.vulnerabilities` mit denselben Schlüsseln —, deshalb
 * liest `parseNpmAudit` beide.
 *
 * yarn bleibt draussen, und zwar begründet: yarn classic schreibt NDJSON, eine
 * Zeile je Advisory, und yarn berry verlangt `yarn npm audit`. Beides ist ein
 * eigener Parser, den heute kein Standout-Projekt braucht. Bis dahin ist ein
 * ehrlicher Hinweis besser als eine Zahl, die aus dem falschen Format stammt.
 *
 * @param {string[]} lockfiles  im Komponentenverzeichnis vorhandene Lockfiles
 * @param {{componentPath?: string|null, rootLockfiles?: string[]}} [context]
 * @returns {{cmd: string, args: string[]}|{hint: string}}
 */
export function jsAuditCommand(lockfiles, { componentPath = null, rootLockfiles = [] } = {}) {
  const pm = packageManagerFrom({ lockfiles })
  if (pm === 'npm' || pm === 'pnpm') return { cmd: pm, args: ['audit', '--json'] }
  if (pm === 'yarn') {
    return { hint: 'yarn.lock — "yarn audit" schreibt ein anderes Format, bitte von Hand' }
  }

  // "kein Lockfile" wäre unwahr, wenn eines an der Repo-Wurzel liegt. Dann ist
  // die Komponente Teil eines Workspace. Dort misst weder npm noch pnpm die
  // Komponente, sondern den ganzen Workspace — dieselbe Zahl je Komponente zu
  // drucken hiesse, denselben Befund mehrfach zu melden. Gemessen wird deshalb
  // nichts; wahr wird nur der Satz.
  const atRoot = rootLockfiles.find((f) => JS_LOCKFILES.includes(f))
  if (atRoot) {
    const where = componentPath ?? 'der Komponente'
    return {
      hint: `kein Lockfile in ${where} — ${atRoot} liegt in der Repo-Wurzel; Workspaces misst der Audit noch nicht`,
    }
  }
  return { hint: 'kein Lockfile' }
}

/**
 * `composer audit --format=json` liefert Advisories je Paket. Ein Paket kann
 * mehrere haben; gezählt werden die Advisories, nicht die Pakete, weil jede
 * einzeln behoben werden muss.
 */
/**
 * `pip-audit --format=json` meldet je Abhaengigkeit eine Liste `vulns`.
 *
 * Anders als npm und composer nennt die PyPI Advisory Database keinen
 * Schweregrad. Die Funde landen deshalb unter `unknown` statt geraten in
 * einem der vier Toepfe — eine erfundene Einstufung waere schlechter als
 * gar keine, weil der Bericht danach Alarm schlaegt oder eben nicht.
 */
export function parsePipAudit(json) {
  const counts = emptySeverities()
  const deps = Array.isArray(json) ? json : (json?.dependencies ?? [])
  for (const dep of deps) {
    for (const _vuln of dep?.vulns ?? []) {
      counts.unknown++
      counts.total++
    }
  }
  return counts
}

export function parseComposerAudit(json) {
  const counts = emptySeverities()
  const advisories = json?.advisories ?? {}
  for (const list of Object.values(advisories)) {
    for (const advisory of Array.isArray(list) ? list : []) {
      const severity = String(advisory.severity ?? '').toLowerCase()
      if (severity === 'medium') counts.moderate++
      else if (SEVERITIES.includes(severity)) counts[severity]++
      else counts.low++
      counts.total++
    }
  }
  return counts
}

/**
 * Liest die Fehlerzahl aus PHPStans JSON — in beiden Formaten.
 *
 * PHPStan 2.2 antwortet in Agent-Umgebungen mit einem eigenen, kürzeren
 * Format und ignoriert dabei `--error-format`. Die Gesamtzahl steht dort in
 * `errors`, die Fundstellen in `error_details` — und diese Liste ist gekappt.
 * Wer stattdessen die 30 aufgeführten Dateien addiert, misst zu wenig; genau
 * das ist bei der ersten Messung schon einmal passiert.
 */
export function parsePhpstanJson(json) {
  if (json && typeof json.errors === 'number' && json.error_details) {
    const byFile = Object.entries(json.error_details)
      .map(([file, list]) => ({ file, errors: Array.isArray(list) ? list.length : 0 }))
      .sort((a, b) => b.errors - a.errors)
    const listed = byFile.reduce((sum, f) => sum + f.errors, 0)
    return { errors: json.errors, byFile, truncated: listed < json.errors }
  }

  // Klassisches Format: `totals.errors` sind allgemeine Fehler (Konfiguration,
  // nicht lesbare Datei), `totals.file_errors` die im Code gefundenen.
  const totals = json?.totals ?? {}
  const errors = Number(totals.file_errors ?? 0) + Number(totals.errors ?? 0)
  const byFile = Object.entries(json?.files ?? {})
    .map(([file, entry]) => ({ file, errors: Number(entry?.errors ?? 0) }))
    .sort((a, b) => b.errors - a.errors)
  return { errors, byFile, truncated: false }
}

/**
 * Zählt die Fehler je Datei aus einer PHPStan-Baseline.
 *
 * Der Umweg über `--generate-baseline` ist nötig, weil PHPStans Agent-Format
 * die Fundstellenliste kappt. Die Baseline dagegen ist vollständig — und erst
 * sie beantwortet die Frage, die über einen Rollout entscheidet: verteilen
 * sich die Fehler über die Codebasis oder stecken sie in drei Dateien?
 */
export function parseBaselineCounts(text) {
  const counts = new Map()
  let pending = 1
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    const count = line.match(/^count:\s*(\d+)$/)
    if (count) {
      pending = Number.parseInt(count[1], 10)
      continue
    }
    const path = line.match(/^path:\s*(.+)$/)
    if (path) {
      const file = path[1].trim().replace(/^['"]|['"]$/g, '')
      counts.set(file, (counts.get(file) ?? 0) + pending)
      pending = 1
    }
  }
  return [...counts.entries()].map(([file, errors]) => ({ file, errors })).sort((a, b) => b.errors - a.errors)
}

/** Zählt Fehlerzeilen in einer `tsc --noEmit`-Ausgabe. */
export function countTscErrors(output) {
  const matches = output.match(/^[^\n]*\berror TS\d+:/gm)
  return matches ? matches.length : 0
}

/**
 * Zählt vorhandene Suppressions und stillgelegte Tests im Bestand.
 *
 * Bewusst dieselben Muster wie der Tamper-Check: was dort im Diff blockiert,
 * ist hier der Altbestand. Zwei Listen wären zwei Wahrheiten.
 */
export function scanHygiene(files) {
  const counts = new Map()
  let todos = 0
  for (const { path, content, isTest } of files) {
    for (const line of content.split('\n')) {
      if (/\b(TODO|FIXME|HACK|XXX)\b/.test(line)) todos++
      for (const rule of LINE_RULES) {
        if (rule.scope === 'test' && !isTest) continue
        if (rule.scope === 'source' && isTest) continue
        if (rule.pattern.test(line)) {
          const entry = counts.get(rule.id) ?? { id: rule.id, label: rule.label, count: 0, paths: new Set() }
          entry.count++
          entry.paths.add(path)
          counts.set(rule.id, entry)
        }
      }
    }
  }
  return {
    todos,
    rules: [...counts.values()]
      .map((e) => ({ id: e.id, label: e.label, count: e.count, files: e.paths.size }))
      .sort((a, b) => b.count - a.count),
  }
}

/**
 * So viele Bestandsfehler gelten noch als abtragbar. Darüber empfiehlt der
 * Audit ein niedrigeres Level: eine Baseline, die niemand mehr abbaut, ist
 * keine Etappe, sondern eine Kapitulation mit Zwischenschritt.
 */
export const BASELINE_TOLERANCE = 500

/**
 * Wählt aus den Messungen ein Startlevel.
 * `measurements` ist eine Liste {level, errors}; fehlende Level sind erlaubt,
 * weil nicht jedes gemessen wird.
 */
export function recommendPhpstanLevel(measurements) {
  const measured = measurements.filter((m) => Number.isInteger(m.level) && Number.isInteger(m.errors))
  if (measured.length === 0) {
    return {
      phpstanLevel: 5,
      baseline: true,
      measured: false,
      reason:
        'nicht gemessen (PHPStan fehlt). Level 5 ist der übliche Einstieg — nach der ersten Messung korrigieren',
    }
  }

  const green = measured.filter((m) => m.errors === 0)
  if (green.length > 0) {
    const best = Math.max(...green.map((m) => m.level))
    return {
      phpstanLevel: best,
      baseline: false,
      measured: true,
      reason: `Level ${best} läuft heute fehlerfrei durch — keine Baseline nötig`,
    }
  }

  const affordable = measured.filter((m) => m.errors <= BASELINE_TOLERANCE)
  if (affordable.length > 0) {
    const best = affordable.reduce((a, b) => (b.level > a.level ? b : a))
    return {
      phpstanLevel: best.level,
      baseline: true,
      measured: true,
      reason: `Level ${best.level} bedeutet ${best.errors} Bestandsfehler in der Baseline`,
    }
  }

  const lowest = measured.reduce((a, b) => (b.level < a.level ? b : a))
  return {
    phpstanLevel: lowest.level,
    baseline: true,
    measured: true,
    reason:
      `schon Level ${lowest.level} hat ${lowest.errors} Fehler — mehr als ${BASELINE_TOLERANCE} in der Baseline ` +
      `wäre eine Zahl, die niemand mehr abträgt. Erst aufräumen, dann höher.`,
  }
}

/**
 * Empfiehlt die Regelschärfe.
 * `strict` verlangt unter anderem, dass Linter-Warnungen als Fehler zählen —
 * das ist nur zumutbar, wenn heute keine offen sind.
 */
export function recommendLevel(components) {
  const results = components.flatMap((comp) => [comp.lint, comp.types].filter(Boolean))
  const measured = results.filter((r) => typeof r.clean === 'boolean')
  const skipped = results.filter((r) => r.skipped)

  if (measured.length === 0) {
    return { level: 'standard', reason: 'weder Linter noch Typprüfung waren messbar' }
  }
  if (measured.some((r) => !r.clean)) {
    return { level: 'standard', reason: 'Linter oder Typprüfung melden heute noch Fundstellen' }
  }
  // Ein übersprungener Schritt ist kein bestandener: was nicht gemessen wurde,
  // darf keine schärfere Einstellung begründen.
  if (skipped.length > 0) {
    return { level: 'standard', reason: 'nicht jede Prüfung war ausführbar — erst vollständig messen, dann verschärfen' }
  }
  return { level: 'strict', reason: 'Linter und Typprüfung laufen heute sauber durch' }
}

/** Baut den quality.yml-Text aus der Empfehlung. */
export function renderConfigYaml({ level, components }) {
  const lines = ['version: 1', `level: ${level}`]
  const baseline = components.some((comp) => comp.baseline)
  lines.push(`baseline: ${baseline}`)
  lines.push('components:')
  for (const comp of components) {
    lines.push(`  - path: ${comp.path}`)
    lines.push(`    stack: ${comp.stack}`)
    if (comp.php) lines.push(`    php: "${comp.php}"`)
    if (Number.isInteger(comp.phpstanLevel)) {
      lines.push(`    phpstan_level: ${comp.phpstanLevel}${comp.note ? `   # ${comp.note}` : ''}`)
    }
  }
  return lines.join('\n') + '\n'
}

/** Fasst die Version aus einem Composer-/npm-Constraint lesbar zusammen. */
export function shortVersion(constraint) {
  if (typeof constraint !== 'string') return null
  const match = constraint.match(/\d+(\.\d+)*/)
  return match ? match[0] : constraint
}
