/**
 * Welche geänderten Dateien PHPStan im vollen Lauf überhaupt prüft.
 *
 * Der Datei-Lauf des Hooks übergibt PHPStan die geänderten Dateien als
 * Argumente. PHPStan analysiert ausdrücklich genannte Dateien auch ausserhalb
 * von `paths`. Eine Option, die das verhindert, hat PHPStan nicht. In adboard
 * erbte der Agent so 40 Altfehler einer Testdatei, die weder der volle Lauf
 * noch CI prüft (13.11.2026). Dieses Modul liest deshalb `paths` und
 * `excludePaths` aus der phpstan.neon und ihren Includes.
 *
 * `phpstan dump-parameters` wäre die Auskunft von PHPStan selbst. Der Befehl
 * kostet aber einen zweiten PHP-Start pro Hook, liefert in ddev Pfade des
 * Containers und gab in adboard ungültiges JSON aus.
 *
 * Grundregel: Kann das Modul die Konfiguration nicht sicher lesen, filtert es
 * nicht. Dann prüft PHPStan alle geänderten Dateien wie bisher. Ein Lesefehler
 * schwächt das Gate also nie ab.
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, resolve, sep } from 'node:path'
import { parseYaml, stripComment } from './yaml.mjs'

/**
 * @typedef {object} Scope
 * @property {string[]} paths absolute Pfade
 * @property {string[]} excludes absolute Pfade oder Muster mit Platzhaltern
 */

/** Platzhalter wie %rootDir% löst nur PHPStan auf. */
const PLACEHOLDER = /%[^%]+%/

/** Zeichen, mit denen fnmatch ein Muster erkennt. */
const WILDCARD = /[*?[]/

/**
 * Die Zeilen unter einem Schlüssel, inklusive der Schlüsselzeile.
 *
 * Gesucht wird nur auf der Einrückung `indent`. Der Block endet an der
 * nächsten Zeile mit kleinerer Einrückung oder an einem weiteren Schlüssel
 * auf derselben Einrückung. Listeneinträge auf der Einrückung des Schlüssels
 * gehören noch zu ihm.
 *
 * @param {string[]} lines Zeilen ohne Kommentare
 * @param {string} key
 * @param {number} indent
 * @returns {string[] | null}
 */
function block(lines, key, indent) {
  const start = lines.findIndex(
    (l) => indentOf(l) === indent && l.trimStart().startsWith(`${key}:`),
  )
  if (start < 0) return null
  const end = lines.findIndex(
    (l, i) =>
      i > start &&
      l.trim() !== '' &&
      (indentOf(l) < indent || (indentOf(l) === indent && !l.trimStart().startsWith('-'))),
  )
  return lines.slice(start, end < 0 ? undefined : end)
}

/**
 * @param {string} line
 * @returns {number}
 */
function indentOf(line) {
  return line.length - line.trimStart().length
}

/**
 * Liest einen Block als YAML. NEON ist für Listen von Pfaden YAML-gleich.
 *
 * @param {string[]} lines
 * @param {number} indent
 * @returns {unknown}
 */
function parseBlock(lines, indent) {
  return parseYaml(lines.map((l) => l.slice(indent)).join('\n'))
}

/**
 * Eine Liste von Zeichenketten oder null, falls der Wert etwas anderes ist.
 *
 * @param {unknown} value
 * @returns {string[] | null}
 */
function stringList(value) {
  if (!Array.isArray(value)) return null
  return value.every((v) => typeof v === 'string') ? value : null
}

/**
 * Ein Eintrag aus excludePaths, ohne die Markierung "(?)" für optionale Pfade.
 *
 * @param {string} entry
 * @returns {string}
 */
function excludeEntry(entry) {
  return entry.replace(/\s*\(\?\)$/, '')
}

/**
 * Liest paths, excludePaths und includes einer Datei.
 *
 * @param {string} file absoluter Pfad
 * @returns {{ paths: string[], excludes: string[], includes: string[] } | null}
 */
function readOne(file) {
  const text = readFileSync(file, 'utf8')
  // Eine mehrzeilige Zeichenkette kann Zeilen enthalten, die wie Schlüssel
  // aussehen. Die Suche nach Blöcken sähe sie als echte Schlüssel.
  if (text.includes("'''") || text.includes('"""')) return null
  const raw = text.split('\n').map(stripComment)
  // NEON erlaubt Tabs, der YAML-Leser nicht. PHPStan schreibt die Baseline
  // mit Tabs. Ein Tab am Zeilenanfang wird darum zu vier Leerzeichen. Mischt
  // eine Einrückung beides, ist die Tiefe unklar: dann lieber nicht filtern.
  if (raw.some((l) => /^( +\t|\t+ )/.test(l))) return null
  const lines = raw.map((l) => l.replace(/^\t+/, (tabs) => '    '.repeat(tabs.length)))
  const base = dirname(file)

  /** @type {string[]} */
  let includes = []
  const inc = block(lines, 'includes', 0)
  if (inc) {
    const list = stringList(/** @type {any} */ (parseBlock(inc, 0))?.includes ?? [])
    if (!list) return null
    if (list.some((v) => PLACEHOLDER.test(v) || WILDCARD.test(v))) return null
    includes = list.map((v) => resolve(base, v))
  }

  const params = block(lines, 'parameters', 0)
  if (!params) return { paths: [], excludes: [], includes }
  // Eine Inline-Map hinter "parameters:" liest dieses Modul nicht.
  if (params[0]?.trim() !== 'parameters:') return null
  const child = params.slice(1).find((l) => l.trim() !== '')
  if (!child) return { paths: [], excludes: [], includes }
  const indent = indentOf(child)

  // "paths!:" ersetzt statt zu ergänzen. Das bildet dieses Modul nicht nach.
  if (block(params, 'paths!', indent) || block(params, 'excludePaths!', indent)) return null

  /** @type {string[]} */
  let paths = []
  const p = block(params, 'paths', indent)
  if (p) {
    const list = stringList(/** @type {any} */ (parseBlock(p, indent))?.paths ?? [])
    if (!list) return null
    paths = list
  }

  /** @type {string[]} */
  let excludes = []
  const e = block(params, 'excludePaths', indent)
  if (e) {
    const value = /** @type {any} */ (parseBlock(e, indent))?.excludePaths ?? []
    // Ein unbekannter Schlüssel wie "analyze" darf keine Ausnahme still verlieren.
    const known = ['analyse', 'analyseAndScan']
    const isMap = value !== null && typeof value === 'object' && !Array.isArray(value)
    if (isMap && Object.keys(value).some((k) => !known.includes(k))) return null
    const list = Array.isArray(value)
      ? stringList(value)
      : isMap
        ? stringList([...(value.analyse ?? []), ...(value.analyseAndScan ?? [])])
        : null
    if (!list) return null
    excludes = list.map(excludeEntry)
  }

  if ([...paths, ...excludes].some((v) => PLACEHOLDER.test(v))) return null
  if (paths.some((v) => WILDCARD.test(v))) return null

  const resolved = paths.map((v) => resolve(base, v))
  // Ein Pfad, der hier fehlt, gilt vielleicht im ddev-Container
  // (/var/www/html/app). Dann trifft der Filter keine Datei: nicht filtern.
  if (resolved.some((v) => !existsSync(v))) return null

  return {
    paths: resolved,
    // Ein Muster mit führendem Platzhalter gilt für jeden Ort.
    excludes: excludes.map((v) => (isAbsolute(v) || /^[*?]/.test(v) ? v : resolve(base, v))),
    includes,
  }
}

/**
 * paths und excludePaths einer Konfiguration samt Includes, oder null, wenn
 * sie sich nicht sicher lesen lassen.
 *
 * Listen aus Includes ergänzen sich wie in PHPStan.
 *
 * @param {string} file absoluter Pfad der phpstan.neon
 * @param {Set<string>} [seen]
 * @returns {Scope | null}
 */
export function readScope(file, seen = new Set()) {
  if (seen.has(file)) return { paths: [], excludes: [] }
  seen.add(file)
  if (!existsSync(file)) return null
  /** @type {ReturnType<typeof readOne>} */
  let own
  try {
    own = readOne(file)
  } catch {
    return null
  }
  if (!own) return null
  /** @type {Scope} */
  const scope = { paths: [], excludes: [] }
  for (const include of own.includes) {
    const sub = readScope(include, seen)
    if (!sub) return null
    scope.paths.push(...sub.paths)
    scope.excludes.push(...sub.excludes)
  }
  scope.paths.push(...own.paths)
  scope.excludes.push(...own.excludes)
  return scope
}

/**
 * Ein fnmatch-Muster als regulärer Ausdruck. Wie PHP ohne Flags: "*" passt
 * auch auf "/".
 *
 * @param {string} pattern
 * @returns {RegExp}
 */
function fnmatch(pattern) {
  let re = ''
  for (let i = 0; i < pattern.length; i++) {
    const c = /** @type {string} */ (pattern[i])
    if (c === '*') re += '.*'
    else if (c === '?') re += '.'
    else if (c === '[') {
      const close = pattern.indexOf(']', i + 1)
      if (close < 0) re += '\\['
      else {
        re += `[${pattern
          .slice(i + 1, close)
          .replace(/^!/, '^')
          .replace(/\\/g, '\\\\')}]`
        i = close
      }
    } else re += c.replace(/[.+^${}()|\\/]/g, '\\$&')
  }
  return new RegExp(`^${re}$`)
}

/**
 * @param {string} file absoluter Pfad
 * @param {string} path absoluter Pfad einer Datei oder eines Ordners
 * @returns {boolean}
 */
function within(file, path) {
  const dir = path.endsWith(sep) ? path : path + sep
  return file === path || file.startsWith(dir)
}

/**
 * Die geänderten Dateien, die PHPStan auch im vollen Lauf prüft.
 *
 * @param {string} dir Verzeichnis der Komponente
 * @param {string} configFile phpstan.neon, relativ zu `dir`
 * @param {string[]} files geänderte Dateien, relativ zu `dir`
 * @returns {string[]} gefilterte Liste; ungefiltert, wenn die Konfiguration
 *   keine paths nennt oder sich nicht sicher lesen lässt
 */
export function filesInScope(dir, configFile, files) {
  const scope = readScope(resolve(dir, configFile))
  if (!scope || scope.paths.length === 0) return files
  const patterns = scope.excludes.filter((e) => WILDCARD.test(e)).map(fnmatch)
  const excluded = scope.excludes.filter((e) => !WILDCARD.test(e))
  return files.filter((f) => {
    const abs = resolve(dir, f)
    if (!scope.paths.some((p) => within(abs, p))) return false
    if (excluded.some((p) => within(abs, p))) return false
    return !patterns.some((re) => re.test(abs))
  })
}
