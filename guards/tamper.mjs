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
export const SOFT_LOCALLY = new Set([
  'protected.changed',
  'dependency.changed',
  'ignore.extended',
  'allowlist.extended',
])

/**
 * Ignore-Dateien von Formatierer und Linter. Eine hinzugefügte Zeile darin nimmt
 * Code aus der Prüfung — dieselbe Wirkung wie eine Suppression, nur eine Ebene
 * höher und ohne Fundstelle im Code selbst.
 *
 * Bewusst NICHT in PROTECTED_PATHS: diese Liste ist gleichzeitig die Blockliste
 * des PreToolUse-Hooks. Eine Positivliste wie die von rankscan/application
 * (`/*` plus `!/resources`) wird legitim erweitert, um Dateien AUFzunehmen; ein
 * Hook, der das blockt, hält die Arbeit auf, ohne etwas zu schützen.
 */
const IGNORE_FILE = /(^|\/)\.(prettier|eslint)ignore$/

/**
 * Konfiguration des Secret-Scanners: .gitleaks.toml und gitleaks.toml.
 * Eine Allowlist darin nimmt Code aus der Prüfung — dieselbe Wirkung wie eine
 * Zeile in .prettierignore, nur bei dem Werkzeug, das Geheimnisse sucht.
 *
 * Aus demselben Grund wie IGNORE_FILE nicht in PROTECTED_PATHS: die Datei wird
 * legitim erweitert — eine eigene [[rules]]-Sektion, ein minVersion-Bump, ein
 * Pfad für einen Upstream-Drop. Ein Hook, der das blockt, hält die Arbeit auf,
 * ohne etwas zu schützen; die Umgehung meldet ohnehin `allowlist.extended`.
 * Die Baseline hinter --baseline-path steht dort sehr wohl: sie ist ein
 * Verzeichnis akzeptierter Funde, wie phpstan-baseline.neon.
 */
const GITLEAKS_FILE = /(^|\/)\.?gitleaks\.toml$/

/** Abschnittskopf: [allowlist], [[allowlists]], [[rules]], [rules.allowlist]. */
const TOML_SECTION = /^\[\[?\s*([^\]\s]+)\s*\]\]?/

/** Schlüssel, die es nur in einer Allowlist gibt. Sie weiten die Ausnahme. */
const ALLOW_KEY = /^(regexes|paths|stopwords|commits|regexTarget)\b/

/** Eintrag einer mehrzeiligen Liste: '''…''' oder "…". */
const LIST_ENTRY = /^('''|"|')/

/** Dateien, in denen Test-Muster überhaupt geprüft werden. */
export const TEST_FILE = /(^|\/)(tests?|__tests__|spec)\//i
// Die Modul-Endungen .mjs/.cjs gehören zwingend dazu: node --test nutzt sie,
// und ohne sie bliebe ein stillgelegter Test in einer .test.mjs unbemerkt.
export const TEST_NAME = /\.(test|spec)\.[mc]?[jt]sx?$|Test\.php$|_test\.py$|test_.*\.py$/i

export const isTestFile = (path) => TEST_FILE.test(path) || TEST_NAME.test(path)

/** Quellcode, in dem Suppressions gesucht werden — nicht in Sperr-/Buildartefakten. */
export const SOURCE_FILE = /\.(php|[jt]sx?|mjs|cjs|vue|py)$/i

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
  { pattern: /(^|\/)\.?gitleaks[-.]baseline\.json$/, label: 'gitleaks-Baseline' },
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
    id: 'suppression.python',
    // `# type: ignore` (mypy), `# noqa` (ruff/flake8) und die Datei-weiten
    // Varianten. Beide sind der Normalfall, mit dem in Python ein Befund
    // stillgelegt wird — das Gegenstueck zu @ts-ignore und eslint-disable.
    pattern: /#\s*(type:\s*ignore|noqa|mypy:\s*(ignore-errors|disable)|ruff:\s*noqa|pyright:\s*ignore)\b/,
    label: 'Python-Suppression',
    scope: 'source',
  },
  {
    id: 'test.skipped',
    pattern:
      /\b(markTestSkipped|->skip\(|\b(it|test|describe|context)\.skip\b|\btest\.todo\b|@doesNotPerformAssertions|@group\s+skip)|@(pytest\.mark\.(skip|skipif|xfail)|unittest\.skip)\b|\bpytest\.skip\s*\(/,
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
 * Muster in ENTFERNTEN Zeilen.
 *
 * Anders bewertet als hinzugefügte: eine einzelne entfernte Zeile sagt nichts —
 * Testcode wird ständig umformuliert. Gezählt wird deshalb netto je Datei, und
 * gemeldet nur, wenn mehr passende Zeilen verschwinden als dazukommen.
 */
export const REMOVED_LINE_RULES = [
  {
    id: 'test.assertions-removed',
    // $this->assertSame( · self::assertTrue( · assert.equal( · expect(x)
    // Dazu Pythons nacktes Statement `assert x == 1`: es hat weder Klammer
    // noch Punkt und fiel deshalb durch jedes der Muster darueber.
    pattern: /\bassert\w*\s*[.(]|->\s*assert\w*\s*\(|::\s*assert\w*\s*\(|\bexpect\s*\(|^\s*assert\s+\S/,
    label: 'netto entfernte Assertions',
    scope: 'test',
  },
]

/**
 * Zerlegt einen unified diff in {path, added: [{line, text}], removed, deleted, renamed}.
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
      current = { path: match ? match[1] : null, added: [], removed: [], deleted: false }
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
    if (raw.startsWith('-') && !raw.startsWith('---')) {
      // Verschiebt die neue Nummerierung nicht, deshalb keine Zeilennummer: die
      // alte zeigte auf einen Zustand, den es nicht mehr gibt.
      current.removed.push({ text: raw.slice(1) })
      continue
    }
    if (raw.startsWith(' ') || raw === '') newLineNo++
  }

  return files.filter((f) => f.path)
}

/**
 * Weitet diese Zeile einer gitleaks-Konfiguration die Ausnahme?
 *
 * `section` ist der Abschnitt, in dem die Zeile steht: 'allow' für eine
 * Allowlist, 'other' für [[rules]] und [extend], null wenn er unbekannt ist.
 * `arrayKey` ist der Schlüssel einer offenen mehrzeiligen Liste.
 */
function widensGitleaks(entry, section, arrayKey) {
  // Der Standard-Regelsatz abgeschaltet: die grösstmögliche Ausnahme, und sie
  // steht in [extend], nicht in der Allowlist.
  if (/^useDefault\s*=\s*false\b/.test(entry)) return true
  // Eine Beschreibung begründet eine Ausnahme, sie weitet sie nicht.
  if (/^description\s*=/.test(entry)) return false
  // Zwei Schlüssel GRENZEN eine Ausnahme ein: targetRules bindet sie an eine
  // benannte Regel, condition = "AND" verlangt alle Kriterien zugleich.
  if (/^targetRules\s*=/.test(entry)) return false
  if (/^condition\s*=\s*["']AND["']/i.test(entry)) return false
  // "OR" weitet dagegen: dann genügt jedes Kriterium für sich. Der Schlüssel
  // kommt nur in einer Allowlist vor, deshalb zählt er ohne Abschnitt.
  if (/^condition\s*=\s*["']OR["']/i.test(entry)) return true
  // Eine hinzugefügte [[rules]]-Sektion VERSCHÄRFT die Prüfung. Sie darf keinen
  // Treffer erzeugen, sonst meldet die Regel das Gegenteil von dem, was passiert.
  if (section === 'other') return false
  if (section === 'allow') return true

  // Abschnitt unbekannt — dann entscheidet der Schlüssel.
  if (ALLOW_KEY.test(entry)) return true
  if (LIST_ENTRY.test(entry)) return arrayKey === null || ALLOW_KEY.test(arrayKey)
  return false
}

/**
 * Sucht in einer gitleaks-Konfiguration die hinzugefügten Zeilen, die eine
 * Ausnahme weiten.
 *
 * Anders als eine .prettierignore ist die Datei strukturiert: dieselbe Zeile
 * bedeutet in [allowlist] das Gegenteil von dem, was sie in [[rules]] bedeutet.
 * Der Abschnitt wird deshalb über die hinzugefügten Zeilen mitgeführt.
 *
 * Die Grenze offen benannt: der Diff kommt mit --unified=0, es gibt keine
 * Kontextzeilen. Wird ein Eintrag mitten in eine bestehende `keywords`-Liste
 * eingefügt, fehlt jeder Hinweis auf den Abschnitt — die Zeile meldet dann,
 * obwohl sie verschärft. Der Fall ist selten; die umgekehrte Voreinstellung
 * wäre der teurere Fehler, weil sie eine weggedrückte Fundstelle verschweigt.
 */
function scanGitleaksConfig(file) {
  const findings = []
  let section = null
  let arrayKey = null

  for (const { line, text } of file.added) {
    const entry = text.trim()
    if (entry === '' || entry.startsWith('#')) continue

    const header = entry.match(TOML_SECTION)
    if (header) {
      // Der letzte Namensteil zählt: [rules.allowlist] ist eine Allowlist.
      const name = header[1].split('.').pop()
      section = /^allowlists?$/i.test(name) ? 'allow' : 'other'
      arrayKey = null
      continue
    }

    // Klammern einer mehrzeiligen Liste tragen selbst keinen Wert.
    const opens = entry.match(/^([A-Za-z_][\w-]*)\s*=\s*\[$/)
    if (opens) {
      arrayKey = opens[1]
      continue
    }
    if (/^[\]}],?$/.test(entry)) {
      arrayKey = null
      continue
    }

    if (!widensGitleaks(entry, section, arrayKey)) continue

    findings.push({
      rule: 'allowlist.extended',
      path: file.path,
      line,
      label: 'erweiterte Secret-Ausnahme',
      detail: entry.slice(0, 120),
    })
  }

  return findings
}

/**
 * Bewertet einen geparsten Diff.
 *
 * `botAuthor` unterdrückt zwei Regeln: die Lockfile-Regel — ein Renovate-Lauf
 * ändert Lockfiles per Definition und würde sonst jedes Mal rot — und seit
 * v0.1.8 auch `protected.changed`.
 *
 * Letzteres, weil Dependabot Action-Versionen in `.github/workflows/**`
 * anhebt, und das ist ein geschützter Pfad. Ohne die Ausnahme ist JEDER
 * Actions-PR rot, auch ein reiner Patch-Bump: Dauerröte auf einem Gate, das
 * genau davon lebt, dass Rot etwas bedeutet.
 *
 * Die Abwägung dahinter: wer einem Bot die Lockdatei glaubt, muss ihm die
 * Versionsreferenz erst recht glauben. Eine Lockdatei kann beliebigen Code
 * nachziehen — sie ist die grössere Angriffsfläche, nicht die kleinere. Die
 * Ausnahme hier nicht zu machen, während sie dort gilt, wäre inkonsequent.
 *
 * Getragen wird das von `isBotAuthor` (guards/tamper-git.mjs): dort müssen
 * ALLE Autoren des Diffs Bots sein. Ein einziger menschlicher Commit im
 * selben PR schaltet beide Regeln wieder scharf — es lässt sich also nichts
 * in einem Bot-PR mitschmuggeln.
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

    for (const { pattern, label } of botAuthor ? [] : PROTECTED_PATHS) {
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

    if (IGNORE_FILE.test(file.path)) {
      for (const { line, text } of file.added) {
        const entry = text.trim()
        // Leerzeilen und Kommentare tragen nichts aus. Ein `!`-Eintrag nimmt
        // Code wieder AUF und ist das Gegenteil einer Umgehung.
        if (entry === '' || entry.startsWith('#') || entry.startsWith('!')) continue

        findings.push({
          rule: 'ignore.extended',
          path: file.path,
          line,
          label: 'erweiterte Prüf-Ausnahme',
          detail: entry.slice(0, 120),
        })
      }
    }

    if (GITLEAKS_FILE.test(file.path)) findings.push(...scanGitleaksConfig(file))

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

    for (const rule of REMOVED_LINE_RULES) {
      if (rule.scope === 'test' ? !inTest : !inSource) continue

      const count = (lines) => lines.filter((entry) => rule.pattern.test(entry.text)).length
      const gone = count(file.removed ?? [])
      const back = count(file.added)

      if (gone > back) {
        findings.push({
          rule: rule.id,
          path: file.path,
          label: rule.label,
          detail: `${gone} entfernt, ${back} hinzugefügt`,
        })
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
