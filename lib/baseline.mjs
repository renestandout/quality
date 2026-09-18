/**
 * PHPStan-Baseline lesen, bewerten und schrumpfen.
 *
 * Gelesen wird der rohe Text, nicht eine Neon-Bibliothek. Der Grund steht im
 * Schreibweg: `applyPrune` entfernt ganze Eintragsblöcke und ändert einzelne
 * `count:`-Zeilen, lässt aber jede überlebende Zeile Byte für Byte stehen.
 * Damit ist die Ausgabe konstruktionsbedingt eine Teilmenge der Eingabe, und
 * der entstehende Diff trägt ausschliesslich Entfernungen — genau das, was der
 * richtungsabhängige Tamper-Check (guards/tamper.mjs) durchlässt. Ein
 * Neuserialisieren würde die Datei umformatieren und jede Zeile als neu
 * ausweisen.
 */
import { resolve } from 'node:path'

/** Ein Listeneintrag: eine Zeile, die nur aus dem Bindestrich besteht. */
const ITEM = /^([ \t]*)-[ \t]*$/

/** Ein Feld des Eintrags: message, identifier, count, path. */
const FIELD = /^([ \t]*)([A-Za-z_][\w-]*)[ \t]*:[ \t]*(.*)$/

/**
 * Löst die Escapes eines doppelt quotierten Neon-Strings auf.
 *
 * In EINEM Durchgang, nicht als Kette von Einzelersetzungen. Der Unterschied
 * ist nicht kosmetisch: `\\n` ist ein maskierter Backslash gefolgt von einem n
 * und muss `\n` als zwei Zeichen bleiben. Eine Kette, die zuerst `\n` in einen
 * Zeilenumbruch verwandelt, macht daraus fälschlich einen Umbruch — und genau
 * solche Folgen stehen in jedem Baseline-Muster (`\\:`, `\\$`, `\\(`).
 */
function decodeEscapes(raw) {
  return raw.replace(/\\(u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|.)/gs, (all, escape) => {
    switch (escape[0]) {
      case 'n':
        return '\n'
      case 't':
        return '\t'
      case 'r':
        return '\r'
      case '"':
        return '"'
      case '\\':
        return '\\'
      case '/':
        return '/'
      case 'u':
      case 'x':
        return String.fromCodePoint(Number.parseInt(escape.slice(1), 16))
      default:
        // Keine bekannte Folge: unverändert lassen statt zu raten.
        return all
    }
  })
}

/**
 * Wert eines Neon-Skalars.
 *
 * In einfachen Anführungszeichen kennt Neon KEINE Backslash-Escapes — ein
 * `\.` bleibt `\.`. Genau darauf beruht der Vergleich mit der Meldung des
 * Analysators, der dieselbe Zeichenfolge zurückgibt. Nur das verdoppelte
 * Anführungszeichen wird aufgelöst.
 */
function decodeNeonScalar(raw) {
  const value = raw.trim()
  if (value.startsWith("'") && value.endsWith("'") && value.length >= 2) {
    return value.slice(1, -1).replaceAll("''", "'")
  }
  if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
    return decodeEscapes(value.slice(1, -1))
  }
  return value
}

/** Öffnet dieser Wert einen mehrzeiligen Neon-Block? Dann steht dort nur der Begrenzer. */
const BLOCK_OPEN = /^("""|''')$/

/**
 * Liest einen mehrzeiligen Neon-String ab der Zeile nach dem Öffner.
 *
 * PHPStan schreibt diese Form, sobald eine Meldung einen Zeilenumbruch
 * enthält — im Bestand 25 von 125 Einträgen in MauticCustomObjects. Der Wert
 * ist der Inhalt, um die gemeinsame Einrückung gekürzt und mit einem
 * Zeilenumbruch verbunden; bei doppelten Anführungszeichen zusätzlich mit
 * gelösten Escapes. An einem echten PHPStan-Lauf nachgeprüft: genau diese
 * Zeichenfolge steht dann in der Meldung `ignore.unmatched`.
 *
 * Gibt null zurück, wenn der Block nicht geschlossen wird. Der Eintrag gilt
 * dann als unlesbar und wird nie angefasst.
 */
function readNeonBlock(lines, start, delimiter) {
  const content = []
  for (let i = start; i < lines.length; i++) {
    if (lines[i].trim() === delimiter) {
      const indents = content.filter((l) => l.trim() !== '').map((l) => l.match(/^[ \t]*/)[0].length)
      const cut = indents.length > 0 ? Math.min(...indents) : 0
      const text = content.map((l) => l.slice(cut)).join('\n')
      return { value: delimiter === '"""' ? decodeEscapes(text) : text, end: i }
    }
    content.push(lines[i])
  }
  return null
}

/**
 * Pfad eines Eintrags, relativ zur Baseline.
 *
 * Erzeugte Baselines schreiben `path: app/A.php`. Älteres und von Hand
 * gepflegtes PHP-Format schreibt `__DIR__ . '/app/A.php'`; beides muss zum
 * selben relativen Pfad führen, sonst findet der Abgleich den Eintrag nicht.
 */
function decodeEntryPath(raw) {
  const value = decodeNeonScalar(raw.trim().replace(/^__DIR__\s*\.\s*/, ''))
  return value.replace(/^\.?\//, '')
}

/**
 * Zerlegt eine Baseline in ihre Einträge, je mit Zeilenbereich.
 *
 * `from`/`to` sind einschliessende Zeilenindizes und umfassen die Leerzeile
 * hinter dem Eintrag. Ein Eintrag ohne `message:` oder ohne `path:` gilt als
 * `readable: false` — solche Einträge werden nie angefasst, weil sich über
 * unbekannten Inhalt nichts entscheiden lässt.
 */
export function parseBaseline(text) {
  const lines = text.split('\n')
  const entries = []
  let current = null

  const close = (endExclusive) => {
    if (!current) return
    let to = endExclusive - 1
    // Der letzte Eintrag endet vor dem Zeilenumbruch am Dateiende. Die leere
    // Zeichenkette dahinter ist kein Inhalt, sondern die Spur dieses Umbruchs.
    if (to === lines.length - 1 && lines[to] === '') to--
    current.to = to
    current.readable = current.message !== null && current.path !== null
    delete current.indent
    entries.push(current)
    current = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    const item = ITEM.exec(line)
    if (item) {
      close(i)
      current = {
        message: null,
        identifier: null,
        count: 1,
        path: null,
        from: i,
        to: i,
        countLine: null,
        readable: false,
        indent: item[1].length,
      }
      continue
    }

    if (!current) continue
    if (line.trim() === '') continue

    const field = FIELD.exec(line)
    if (!field || field[1].length <= current.indent) {
      // Weniger eingerückt als der Bindestrich: der Eintrag ist hier zu Ende.
      close(i)
      continue
    }

    const [, , key, value] = field

    // Ein Block-String erstreckt sich über mehrere Zeilen. Ohne diesen Zweig
    // endete der Eintrag am ersten Inhaltsstück, weil das kein Feld ist.
    const delimiter = value.trim()
    if (key === 'message' && BLOCK_OPEN.test(delimiter)) {
      const block = readNeonBlock(lines, i + 1, delimiter)
      if (!block) {
        // Unabgeschlossener Block: abbrechen, der Eintrag bleibt unlesbar.
        close(lines.length)
        break
      }
      current.message = block.value
      i = block.end
      continue
    }

    if (key === 'message') current.message = decodeNeonScalar(value)
    else if (key === 'identifier') current.identifier = decodeNeonScalar(value)
    else if (key === 'path') current.path = decodeEntryPath(value)
    else if (key === 'count') {
      const count = Number.parseInt(value.trim(), 10)
      if (Number.isInteger(count)) {
        current.count = count
        current.countLine = i
      }
    }
  }
  close(lines.length)

  return { lines, entries }
}

/** Was PHPStan einer Musterdarstellung voranstellt. Das lange Präfix zuerst. */
const PATTERN_PREFIX = 'Ignored error pattern '
const RAW_PREFIX = 'Ignored error '

/** Der Eintrag hat nichts mehr getroffen — identifier "ignore.unmatched". */
const DEAD_SUFFIX = ' was not matched in reported errors.'

/**
 * Der Zähler steht zu hoch — identifier "ignore.count". Beide Zahlwörter
 * müssen mitgelesen werden: bei genau einem Treffer schreibt PHPStan "1 time".
 */
const COUNT_SUFFIX = / is expected to occur \d+ times?, but occurred (?:only )?(\d+) times?\.$/

/**
 * Schneidet die Pfadangabe von der Musterdarstellung ab.
 *
 * Bevorzugt wörtlich anhand der Datei, auf die PHPStan den Befund bezieht.
 * Ersatzweise an der LETZTEN Fundstelle von " in path ": der Pfad steht immer
 * am Ende. Der Ersatzweg greift, wenn PHPStan den Pfad in der Meldung anders
 * normalisiert als in der Fehlerzuordnung.
 */
function stripPath(rest, file) {
  const exact = ` in path ${file}`
  if (rest.endsWith(exact)) return rest.slice(0, -exact.length)
  const at = rest.lastIndexOf(' in path ')
  return at === -1 ? rest : rest.slice(0, at)
}

/**
 * Liest aus einem PHPStan-JSON-Bericht die Aussagen über die Baseline.
 *
 * `dead` sind Einträge, die nichts mehr treffen. `overcounted` sind Einträge,
 * deren `count:` über der tatsächlichen Zahl liegt. `blockers` sind
 * nicht-dateibezogene Fehler — ein interner Abbruch oder ein
 * Konfigurationsfehler. Solange die Liste nicht leer ist, darf nichts
 * geschrumpft werden: ein Lauf, der abgebrochen ist, meldet lebende Einträge
 * als tot.
 *
 * Zurück kommt je Fund die Datei und der `core` der Musterdarstellung —
 * `<message> (<identifier>)` oder `<message>`. Genau diese Zeichenfolge baut
 * `planPrune` aus einem Baseline-Eintrag nach; damit braucht der Abgleich
 * keine Zerlegung des Musters selbst.
 */
export function readIgnoreFindings(report) {
  const dead = []
  const overcounted = []
  const blockers = (report?.errors ?? []).map((e) => (typeof e === 'string' ? e : (e?.message ?? String(e))))

  for (const [file, fileReport] of Object.entries(report?.files ?? {})) {
    for (const message of fileReport?.messages ?? []) {
      const kind = message?.identifier
      if (kind !== 'ignore.unmatched' && kind !== 'ignore.count') continue

      const text = String(message.message ?? '')
      const body = text.startsWith(PATTERN_PREFIX)
        ? text.slice(PATTERN_PREFIX.length)
        : text.startsWith(RAW_PREFIX)
          ? text.slice(RAW_PREFIX.length)
          : null
      if (body === null) continue

      if (kind === 'ignore.unmatched') {
        if (!body.endsWith(DEAD_SUFFIX)) continue
        dead.push({ file, core: stripPath(body.slice(0, -DEAD_SUFFIX.length), file) })
        continue
      }

      const hit = COUNT_SUFFIX.exec(body)
      if (!hit) continue
      overcounted.push({
        file,
        core: stripPath(body.slice(0, hit.index), file),
        actual: Number.parseInt(hit[1], 10),
      })
    }
  }

  return { dead, overcounted, blockers }
}

/**
 * Musterdarstellung eines Eintrags, wie PHPStan sie in seine Meldungen
 * schreibt. Nachgebaut statt zerlegt: eine Zeichenfolge, die aus dem Eintrag
 * entsteht, lässt sich mit der gemeldeten wörtlich vergleichen. Ein Zerlegen
 * der gemeldeten Zeichenfolge müsste dagegen das Muster selbst parsen, das
 * Klammern und Leerzeichen enthält.
 */
function entryCore(entry) {
  return entry.identifier ? `${entry.message} (${entry.identifier})` : entry.message
}

function matches(entry, finding, dir) {
  if (!entry.readable) return false
  if (entryCore(entry) !== finding.core) return false
  if (resolve(dir, entry.path) === resolve(finding.file)) return true
  // Ersatzvergleich über das Pfadende. Nötig, weil derselbe Ordner unter zwei
  // Namen erreichbar sein kann — auf macOS etwa /var und /private/var. Der
  // Vergleich bleibt eindeutig, weil das Muster ohnehin stimmen muss.
  return resolve(finding.file).endsWith(`/${entry.path}`)
}

/**
 * Entscheidet je Baseline-Eintrag: entfernen, Zähler senken oder stehen lassen.
 *
 * `dir` ist das Verzeichnis der Baseline — die Pfade der Einträge sind darauf
 * bezogen. Zurück kommen nur Indizes in `parsed.entries`; geschrieben wird
 * nichts. Was der Plan nicht nennt, bleibt unangetastet.
 *
 * Zwei Regeln machen das Ergebnis richtungssicher: Ein Zähler wird nur
 * gesenkt, nie angehoben. Und bei einer Sperre (`blockers`) entsteht gar kein
 * Vorschlag.
 */
export function planPrune({ entries }, findings, { dir }) {
  const blockers = findings.blockers ?? []
  if (blockers.length > 0) return { drop: [], lower: [], unclaimed: [], blockers }

  const drop = []
  const lower = []
  const unclaimed = []
  const claim = (finding) => entries.findIndex((entry) => matches(entry, finding, dir))

  for (const finding of findings.dead ?? []) {
    const index = claim(finding)
    if (index === -1) unclaimed.push({ file: finding.file, core: finding.core })
    else if (!drop.includes(index)) drop.push(index)
  }

  for (const finding of findings.overcounted ?? []) {
    const index = claim(finding)
    if (index === -1) {
      unclaimed.push({ file: finding.file, core: finding.core })
      continue
    }
    const entry = entries[index]
    // Eine HÖHERE tatsächliche Zahl bedeutet neue Fehler. Die gehören nicht in
    // die Baseline; PHPStan meldet sie ohnehin gesondert als echte Befunde.
    if (finding.actual >= 1 && finding.actual < entry.count) lower.push({ index, count: finding.actual })
  }

  drop.sort((a, b) => a - b)
  return { drop, lower: lower.filter((l) => !drop.includes(l.index)), unclaimed, blockers }
}

/**
 * Schreibt die Baseline nach Plan neu — als Textfilter.
 *
 * Entfernt die Zeilenbereiche der geplanten Einträge und ersetzt einzelne
 * `count:`-Zeilen. Jede andere Zeile geht wörtlich durch. Damit gilt: die
 * Ausgabe enthält keine Zeile, die die Eingabe nicht hatte — ausser einer
 * gesenkten Zähler-Zeile.
 *
 * Der Kopf (`parameters:` / `ignoreErrors:`) bleibt auch dann stehen, wenn
 * kein Eintrag übrig bleibt. Ein leerer `ignoreErrors:`-Schlüssel ist gültig;
 * ihn durch `[]` zu ersetzen wäre eine hinzugefügte Zeile und damit kein
 * Schrumpfen mehr.
 */
export function applyPrune({ lines, entries }, plan) {
  const removed = new Set()
  for (const index of plan.drop ?? []) {
    const entry = entries[index]
    if (!entry) continue
    for (let i = entry.from; i <= entry.to; i++) removed.add(i)
  }

  const lowered = new Map()
  for (const { index, count } of plan.lower ?? []) {
    const entry = entries[index]
    if (!entry || entry.countLine === null) continue
    lowered.set(entry.countLine, lines[entry.countLine].replace(/\d+[ \t]*$/, String(count)))
  }

  const kept = []
  for (let i = 0; i < lines.length; i++) {
    if (removed.has(i)) continue
    kept.push(lowered.get(i) ?? lines[i])
  }

  // Die Trennzeile eines Eintrags gehört dem Eintrag DAVOR. Fällt der letzte
  // weg, bleibt sie als Leerzeile am Dateiende stehen. Zusammenziehen auf
  // einen Umbruch entfernt nur — es kommt nichts hinzu.
  return kept.join('\n').replace(/\n+$/, '\n')
}
