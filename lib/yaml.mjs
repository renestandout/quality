/**
 * Minimaler YAML-Leser für quality.yml.
 *
 * Bewusst kein vollständiges YAML: das Paket wird auch über Composer installiert,
 * wo kein node_modules danebenliegt — eine Dependency wäre dort nicht verfügbar.
 * Unterstützt werden Maps, Sequenzen, Inline-Maps/-Listen und einfache Skalare.
 * Alles andere (Anker, mehrzeilige Blöcke, Tabs) wird abgelehnt statt still
 * falsch interpretiert.
 */

/** @typedef {string | number | boolean | null} YamlScalar */

/** @typedef {YamlScalar | YamlList | YamlMap} YamlValue */

/** @typedef {YamlValue[]} YamlList */

/** @typedef {{ [key: string]: YamlValue }} YamlMap */

/**
 * Eine nicht leere Zeile der Datei, ohne Kommentar.
 *
 * @typedef {object} Line
 * @property {number} indent
 * @property {string} text
 * @property {number} lineNo
 */

/** @typedef {[YamlValue, number]} ParseResult Wert und Index der ersten nicht verbrauchten Zeile */

class YamlError extends Error {
  /**
   * @param {string} message
   * @param {number} [lineNo]
   */
  constructor(message, lineNo) {
    super(lineNo ? `${message} (Zeile ${lineNo})` : message)
    this.name = 'YamlError'
  }
}

/**
 * Entfernt einen Kommentar, ohne '#' innerhalb von Anführungszeichen anzutasten.
 *
 * @param {string} line
 * @returns {string}
 */
function stripComment(line) {
  /** @type {string | null} */
  let quote = null
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
    } else if (c === '"' || c === "'") {
      quote = c
    } else if (
      // Bei i > 0 existiert line[i - 1].
      c === '#' &&
      (i === 0 || /\s/.test(/** @type {string} */ (line[i - 1])))
    ) {
      return line.slice(0, i)
    }
  }
  return line
}

/**
 * @param {string} raw
 * @param {number} lineNo
 * @returns {YamlScalar}
 */
function parseScalar(raw, lineNo) {
  const s = raw.trim()
  if (s === '') return null
  if (s === 'null' || s === '~') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number.parseInt(s, 10)
  if (/^-?\d*\.\d+$/.test(s)) return Number.parseFloat(s)
  if (s[0] === '"' || s[0] === "'") {
    const q = s[0]
    if (s.length < 2 || s[s.length - 1] !== q) {
      throw new YamlError(`Nicht geschlossenes Anführungszeichen: ${s}`, lineNo)
    }
    return s.slice(1, -1).replace(/\\(.)/g, '$1')
  }
  return s
}

/**
 * Zerlegt den Inhalt von {…} bzw. […] auf oberster Ebene an Kommas.
 *
 * @param {string} body
 * @param {number} lineNo
 * @returns {string[]}
 */
function splitInline(body, lineNo) {
  /** @type {string[]} */
  const parts = []
  let depth = 0
  /** @type {string | null} */
  let quote = null
  let start = 0
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === ',' && depth === 0) {
      parts.push(body.slice(start, i))
      start = i + 1
    }
  }
  if (depth !== 0) throw new YamlError('Unausgeglichene Klammern', lineNo)
  const last = body.slice(start)
  if (last.trim() !== '' || parts.length > 0) parts.push(last)
  return parts.filter((p) => p.trim() !== '')
}

/**
 * @param {string} raw
 * @param {number} lineNo
 * @returns {YamlValue}
 */
function parseInline(raw, lineNo) {
  const s = raw.trim()
  if (s.startsWith('{')) {
    if (!s.endsWith('}')) throw new YamlError('Inline-Map nicht geschlossen', lineNo)
    /** @type {YamlMap} */
    const out = {}
    for (const part of splitInline(s.slice(1, -1), lineNo)) {
      const idx = part.indexOf(':')
      if (idx === -1) throw new YamlError(`Inline-Map ohne ':' bei "${part.trim()}"`, lineNo)
      // String() wandelt den Schlüssel so um, wie es der Property-Zugriff ohnehin täte.
      out[String(parseScalar(part.slice(0, idx), lineNo))] = parseValue(part.slice(idx + 1), lineNo)
    }
    return out
  }
  if (!s.endsWith(']')) throw new YamlError('Inline-Liste nicht geschlossen', lineNo)
  return splitInline(s.slice(1, -1), lineNo).map((p) => parseValue(p, lineNo))
}

/**
 * @param {string} raw
 * @param {number} lineNo
 * @returns {YamlValue}
 */
function parseValue(raw, lineNo) {
  const s = raw.trim()
  if (s.startsWith('{') || s.startsWith('[')) return parseInline(s, lineNo)
  return parseScalar(s, lineNo)
}

/**
 * Bereitet die Datei als Liste von {indent, text, lineNo} auf.
 *
 * @param {string} text
 * @returns {Line[]}
 */
function toLines(text) {
  /** @type {Line[]} */
  const out = []
  text.split(/\r?\n/).forEach((original, i) => {
    const lineNo = i + 1
    if (original.includes('\t')) {
      throw new YamlError(
        'Tabulatoren sind in quality.yml nicht erlaubt, bitte Leerzeichen verwenden',
        lineNo,
      )
    }
    const stripped = stripComment(original)
    if (stripped.trim() === '') return
    out.push({
      indent: stripped.length - stripped.trimStart().length,
      text: stripped.trim(),
      lineNo,
    })
  })
  return out
}

/**
 * Liest eine Zeile, deren Index der Aufrufer bereits gegen lines.length geprüft hat.
 *
 * @param {Line[]} lines
 * @param {number} i
 * @returns {Line}
 */
function lineAt(lines, i) {
  // Alle Aufrufer prüfen vorher i < lines.length, die Zeile existiert also.
  return /** @type {Line} */ (lines[i])
}

/**
 * @param {Line[]} lines
 * @param {number} start
 * @param {number} indent
 * @returns {ParseResult}
 */
function parseNode(lines, start, indent) {
  if (start >= lines.length) return [null, start]
  return lineAt(lines, start).text.startsWith('- ') || lineAt(lines, start).text === '-'
    ? parseSequence(lines, start, indent)
    : parseMap(lines, start, indent)
}

/**
 * @param {Line[]} lines
 * @param {number} start
 * @param {number} indent
 * @returns {ParseResult}
 */
function parseSequence(lines, start, indent) {
  /** @type {YamlList} */
  const items = []
  let i = start
  while (i < lines.length && lineAt(lines, i).indent === indent) {
    const line = lineAt(lines, i)
    if (!line.text.startsWith('-')) break
    const rest = line.text === '-' ? '' : line.text.slice(2)
    if (rest.trim() === '') {
      // Blockelement: der Inhalt folgt eingerückt auf der nächsten Zeile.
      i++
      if (i >= lines.length || lineAt(lines, i).indent <= indent) {
        throw new YamlError('Leerer Listeneintrag', line.lineNo)
      }
      const [value, next] = parseNode(lines, i, lineAt(lines, i).indent)
      items.push(value)
      i = next
      continue
    }
    if (rest.trim().startsWith('{') || rest.trim().startsWith('[')) {
      items.push(parseInline(rest, line.lineNo))
      i++
      continue
    }
    const colon = indexOfKeySeparator(rest)
    if (colon === -1) {
      items.push(parseScalar(rest, line.lineNo))
      i++
      continue
    }
    // "- key: wert" — erster Eintrag einer Map, weitere folgen tiefer eingerückt.
    const inner = [{ indent: 0, text: rest, lineNo: line.lineNo }]
    const childIndent = indent + 2
    i++
    while (
      i < lines.length &&
      lineAt(lines, i).indent >= childIndent &&
      !(lineAt(lines, i).indent === indent)
    ) {
      inner.push({
        indent: lineAt(lines, i).indent - childIndent,
        text: lineAt(lines, i).text,
        lineNo: lineAt(lines, i).lineNo,
      })
      i++
    }
    const [value] = parseMap(inner, 0, 0)
    items.push(value)
  }
  return [items, i]
}

/**
 * Findet den ':'-Trenner eines Map-Eintrags, ignoriert ':' in Quotes/Klammern.
 *
 * @param {string} text
 * @returns {number}
 */
function indexOfKeySeparator(text) {
  /** @type {string | null} */
  let quote = null
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\') i++
      else if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (
      // Bei i + 1 < text.length existiert text[i + 1].
      c === ':' &&
      depth === 0 &&
      (i + 1 === text.length || /\s/.test(/** @type {string} */ (text[i + 1])))
    )
      return i
  }
  return -1
}

/**
 * @param {Line[]} lines
 * @param {number} start
 * @param {number} indent
 * @returns {ParseResult}
 */
function parseMap(lines, start, indent) {
  /** @type {YamlMap} */
  const map = {}
  let i = start
  while (i < lines.length && lineAt(lines, i).indent === indent) {
    const line = lineAt(lines, i)
    if (line.text.startsWith('- ')) break
    const colon = indexOfKeySeparator(line.text)
    if (colon === -1)
      throw new YamlError(`Erwartet "schlüssel: wert", gefunden "${line.text}"`, line.lineNo)
    // String() wandelt den Schlüssel so um, wie es der Property-Zugriff ohnehin täte.
    const key = parseScalar(line.text.slice(0, colon), line.lineNo)
    const rest = line.text.slice(colon + 1).trim()
    if (rest !== '') {
      map[String(key)] = parseValue(rest, line.lineNo)
      i++
      continue
    }
    // Verschachtelter Block: Sequenzen dürfen auf gleicher Höhe stehen (YAML erlaubt beides).
    const next = lines[i + 1]
    if (!next || (next.indent <= indent && !next.text.startsWith('- '))) {
      map[String(key)] = null
      i++
      continue
    }
    const [value, after] = parseNode(lines, i + 1, next.indent)
    map[String(key)] = value
    i = after
  }
  return [map, i]
}

/**
 * @param {string} text Inhalt von quality.yml
 * @returns {YamlValue}
 */
export function parseYaml(text) {
  const lines = toLines(text)
  if (lines.length === 0) return {}
  const [value, consumed] = parseNode(lines, 0, lineAt(lines, 0).indent)
  if (consumed < lines.length) {
    throw new YamlError(
      `Unerwartete Einrückung bei "${lineAt(lines, consumed).text}"`,
      lineAt(lines, consumed).lineNo,
    )
  }
  return value
}

export { YamlError }
