/**
 * Tamper-Check: erkennt im Diff die Handgriffe, mit denen sich ein Gate
 * umgehen lässt, statt es zu erfüllen.
 *
 * Das ist der Teil des Frameworks, der speziell für agentische Entwicklung
 * existiert. Lokale Hooks kann ein Agent umgehen; dieser Check läuft in CI
 * über den fertigen Diff und ist damit die Wahrheit über Mergefähigkeit.
 *
 * Grundsatz: Keine Regel verbietet etwas endgültig. Jeder Treffer lässt sich
 * mit dem Commit-Trailer "Quality-Exception: <grund>" durchwinken — den setzt
 * ein Mensch. Der legitime Fall bleibt möglich, aber sichtbar und bewusst.
 */

export const EXCEPTION_TRAILER = 'Quality-Exception:'

/**
 * Regeln, die lokal nur berichtet und erst in CI bindend werden.
 *
 * Beides beschreibt Arbeit, die typischerweise vom Menschen kommt: die
 * Gate-Konfiguration anlegen oder ein Paket hinzufügen. Lokal gibt es noch
 * keinen Commit und damit keinen Trailer, mit dem man das durchwinken könnte —
 * ein Projekt käme sonst gar nicht erst durch sein eigenes Onboarding.
 */
export const SOFT_LOCALLY = new Set(['protected.changed', 'dependency.changed'])

/** Dateien, in denen Test-Muster überhaupt geprüft werden. */
const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\//i
// Die Modul-Endungen .mjs/.cjs gehören zwingend dazu: node --test nutzt sie,
// und ohne sie bliebe ein stillgelegter Test in einer .test.mjs unbemerkt.
const TEST_NAME = /\.(test|spec)\.[mc]?[jt]sx?$|Test\.php$|_test\.py$|test_.*\.py$/i

const isTestFile = (path) => TEST_FILE.test(path) || TEST_NAME.test(path)

/** Quellcode, in dem Suppressions gesucht werden — nicht in Sperr-/Buildartefakten. */
const SOURCE_FILE = /\.(php|[jt]sx?|mjs|cjs|vue|py)$/i

/**
 * Dateien, die das Gate selbst definieren. Dieselbe Liste dient dem
 * PreToolUse-Hook als Blockliste — es soll nicht zwei Wahrheiten darüber
 * geben, was geschützt ist.
 */
export const PROTECTED_PATHS = [
  // Der CI-Workflow steht zuerst: eine Datei wie .github/workflows/quality.yml
  // ist ein Workflow und keine Quality-Konfiguration, auch wenn sie so heisst.
  { pattern: /^\.github\/workflows\//, label: 'CI-Workflow' },
  { pattern: /(^|\/)phpstan-baseline\.neon$/, label: 'PHPStan-Baseline' },
  { pattern: /(^|\/)eslint-suppressions\.json$/, label: 'ESLint-Suppressions' },
  { pattern: /^quality\.ya?ml$/, label: 'Quality-Konfiguration' },
  { pattern: /(^|\/)phpstan\.neon(\.dist)?$/, label: 'PHPStan-Konfiguration' },
  { pattern: /(^|\/)pint\.json$/, label: 'Pint-Konfiguration' },
  { pattern: /(^|\/)\.prettierrc/, label: 'Prettier-Konfiguration' },
  // [cm]? deckt .mjs/.cjs/.mts/.cts mit ab. Ohne das war die Linter- und
  // Formatiererkonfiguration in genau den Projekten ungeschützt, die sie am
  // ehesten so benennen: wer kein "type": "module" im package.json hat, MUSS
  // .mjs verwenden, sonst lädt die Konfiguration gar nicht. Gefunden am
  // 16.08.2026 in rankscan/website, wo beide Dateien .mjs heissen.
  { pattern: /(^|\/)prettier\.config\.[cm]?[jt]s$/, label: 'Prettier-Konfiguration' },
  { pattern: /(^|\/)eslint\.config\.[cm]?[jt]s$/, label: 'ESLint-Konfiguration' },
  { pattern: /(^|\/)\.oxlintrc\.json$/, label: 'oxlint-Konfiguration' },
  { pattern: /(^|\/)\.claude\/settings\.json$/, label: 'Claude-Hook-Konfiguration' },
]

const LOCKFILES = /(^|\/)(composer\.lock|package-lock\.json|pnpm-lock\.yaml|yarn\.lock)$/

/**
 * Fremdcode. Wird nie bewertet — auch dann nicht, wenn ein Projekt seine
 * Abhängigkeiten mitcommittet, wie es bei gewachsenen CMS-Projekten
 * regelmässig vorkommt. Ein `@ts-ignore` in einem fremden Paket ist keine
 * Umgehung durch den Entwickler, sondern die Arbeit von jemand anderem.
 */
export const VENDOR_PATH = /(^|\/)(vendor|node_modules|bower_components|\.venv|venv|third_party)\//

/**
 * Muster in hinzugefügten Zeilen.
 * `scope: 'test'` beschränkt die Prüfung auf Testdateien — "skip" oder "only"
 * in Produktivcode ist gewöhnlicher Code und kein Umgehungsversuch.
 */
export const LINE_RULES = [
  {
    id: 'suppression.phpstan',
    // eslint-disable-next-line -- Muster, nicht Anwendung
    pattern: /@phpstan-ignore(-next-line|-line)?\b/,
    label: 'PHPStan-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.psalm',
    pattern: /@psalm-suppress\b/,
    label: 'Psalm-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.typescript',
    pattern: /@ts-(ignore|expect-error|nocheck)\b/,
    label: 'TypeScript-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.eslint',
    pattern: /\beslint-disable(-next-line|-line)?\b/,
    label: 'ESLint-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.oxlint',
    pattern: /\boxlint-disable(-next-line|-line)?\b/,
    label: 'oxlint-Suppression',
    scope: 'source',
  },
  {
    id: 'suppression.phpcs',
    pattern: /\bphpcs:(ignore|disable)\b/,
    label: 'PHPCS-Suppression',
    scope: 'source',
  },
  {
    id: 'test.skipped',
    pattern: /\b(markTestSkipped|->skip\(|\b(it|test|describe|context)\.skip\b|\btest\.todo\b|@doesNotPerformAssertions|@group\s+skip)/,
    label: 'übersprungener Test',
    scope: 'test',
  },
  {
    id: 'test.focused',
    // .only lässt die restliche Suite still verstummen — im Merge fast immer ein Versehen.
    pattern: /\b(it|test|describe|context)\.only\b|\bfit\(|\bfdescribe\(/,
    label: 'auf einen Fall verengter Testlauf (.only)',
    scope: 'test',
  },
  {
    id: 'test.incomplete',
    pattern: /\bmarkTestIncomplete\(/,
    label: 'als unvollständig markierter Test',
    scope: 'test',
  },
]

/**
 * Zerlegt einen unified diff in {path, added: [{line, text}], deleted, renamed}.
 * Bewusst genügsam: es zählt, welche Zeilen hinzugekommen sind und welche
 * Dateien verschwunden sind.
 */
export function parseDiff(diffText) {
  const files = []
  let current = null
  let newLineNo = 0

  for (const raw of diffText.split('\n')) {
    if (raw.startsWith('diff --git ')) {
      // "diff --git a/pfad b/pfad" — der b-Pfad ist der Zielzustand.
      const match = raw.match(/ b\/(.*)$/)
      current = { path: match ? match[1] : null, added: [], deleted: false }
      files.push(current)
      continue
    }
    if (!current) continue
    if (raw.startsWith('deleted file mode')) {
      current.deleted = true
      continue
    }
    if (raw.startsWith('+++ ')) {
      // Bei gelöschten Dateien steht hier /dev/null; den a-Pfad haben wir schon.
      const path = raw.slice(4).trim()
      if (path !== '/dev/null' && path.startsWith('b/')) current.path = path.slice(2)
      continue
    }
    if (raw.startsWith('--- ')) {
      const path = raw.slice(4).trim()
      if (current.deleted && path.startsWith('a/')) current.path = path.slice(2)
      continue
    }
    if (raw.startsWith('@@')) {
      const match = raw.match(/@@ -\d+(?:,\d+)? \+(\d+)/)
      newLineNo = match ? Number.parseInt(match[1], 10) : 0
      continue
    }
    if (raw.startsWith('+') && !raw.startsWith('+++')) {
      current.added.push({ line: newLineNo, text: raw.slice(1) })
      newLineNo++
      continue
    }
    if (raw.startsWith('-')) continue // entfernte Zeile: verschiebt die neue Nummerierung nicht
    if (raw.startsWith(' ') || raw === '') newLineNo++
  }

  return files.filter((f) => f.path)
}

/**
 * Bewertet einen geparsten Diff.
 * `botAuthor` unterdrückt die Lockfile-Regel: ein Renovate-Lauf ändert
 * Lockfiles per Definition und würde sonst jedes Mal rot.
 */
export function analyseDiff(files, { botAuthor = false, ignorePaths = [] } = {}) {
  const findings = []
  const ignored = (path) => ignorePaths.some((p) => path.startsWith(p))

  for (const file of files) {
    if (ignored(file.path) || VENDOR_PATH.test(file.path)) continue

    if (file.deleted) {
      if (isTestFile(file.path)) {
        findings.push({
          rule: 'test.deleted',
          path: file.path,
          label: 'gelöschte Testdatei',
          detail: 'Die Datei wurde entfernt.',
        })
      }
      continue
    }

    for (const { pattern, label } of PROTECTED_PATHS) {
      if (pattern.test(file.path)) {
        findings.push({
          rule: 'protected.changed',
          // Nachgestellt, damit die Meldung unabhängig vom Genus stimmt:
          // "CI-Workflow geändert", "PHPStan-Baseline geändert".
          label: `${label} geändert`,
          path: file.path,
          detail: 'Änderungen hieran verschieben das Gate selbst.',
        })
        break
      }
    }

    if (LOCKFILES.test(file.path) && !botAuthor) {
      findings.push({
        rule: 'dependency.changed',
        path: file.path,
        label: 'geänderte Abhängigkeiten',
        detail: 'Neue oder aktualisierte Pakete gehören begründet.',
      })
    }

    const inTest = isTestFile(file.path)
    const inSource = SOURCE_FILE.test(file.path)
    for (const { line, text } of file.added) {
      for (const rule of LINE_RULES) {
        const applies = rule.scope === 'test' ? inTest : inSource
        if (!applies) continue
        if (rule.pattern.test(text)) {
          findings.push({
            rule: rule.id,
            path: file.path,
            line,
            label: rule.label,
            detail: text.trim().slice(0, 120),
          })
        }
      }
    }
  }

  return findings
}

/** Sucht den Ausnahme-Trailer in den Commit-Nachrichten des geprüften Bereichs. */
export function findException(commitMessages) {
  for (const message of commitMessages) {
    for (const line of message.split('\n')) {
      const trimmed = line.trim()
      if (trimmed.toLowerCase().startsWith(EXCEPTION_TRAILER.toLowerCase())) {
        const reason = trimmed.slice(EXCEPTION_TRAILER.length).trim()
        if (reason) return reason
      }
    }
  }
  return null
}
