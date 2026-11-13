/**
 * Versions-Commit von quality — nur auf einem main mit grüner CI.
 *
 * Der Anlass: Am 13.11.2026 lag der Release-Commit 0.2.29 auf einem main mit
 * roter CI. Der Fehler trat nur unter Linux auf, lokal war alles grün. Das
 * Claude-Code-Plugin holt main, sobald die Version in plugin.json steigt. Ein
 * roter Release-Commit geht so direkt in die Hooks aller Konten.
 *
 * Darum fragt das Skript vor dem Commit `deploy-check` nach dem Stand von
 * origin/main. Es bricht ab, bevor es eine Datei schreibt. Es setzt keinen Tag
 * und pusht nicht: beides bleibt ein bewusster Schritt des Menschen.
 *
 * Aufruf: `node scripts/release.mjs <version>`.
 * Notfall: `QUALITY_DEPLOY_OVERRIDE="<Begründung>"` wie beim Deploy.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { runDeployCheck } from './deploy-check.mjs'

/** Die Dateien, die ein Versions-Commit ändert. Beispiel: e86767d (0.2.30). */
export const VERSION_FILES = [
  '.claude-plugin/marketplace.json',
  '.claude-plugin/plugin.json',
  'README.md',
  'package-lock.json',
  'package.json',
]

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/

/**
 * Die Versionsfelder je JSON-Datei, als Pfad im geparsten Objekt.
 *
 * @type {Record<string, (string | number)[][]>}
 */
const JSON_FIELDS = {
  '.claude-plugin/marketplace.json': [['plugins', 0, 'version']],
  '.claude-plugin/plugin.json': [['version']],
  'package-lock.json': [['version'], ['packages', '', 'version']],
  'package.json': [['version']],
}

/**
 * @param {string} version
 * @returns {number[] | null}
 */
function parseVersion(version) {
  const match = SEMVER.exec(version)
  return match ? match.slice(1).map(Number) : null
}

/**
 * @param {number[]} a
 * @param {number[]} b
 * @returns {boolean}
 */
function isHigher(a, b) {
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0)
  }
  return false
}

/**
 * @param {any} obj
 * @param {(string | number)[]} path
 * @param {string} value
 */
function setPath(obj, path, value) {
  let node = obj
  for (const key of path.slice(0, -1)) node = node?.[key]
  const last = /** @type {string | number} */ (path.at(-1))
  if (node === null || typeof node !== 'object' || !(last in node)) {
    throw new Error(`Feld ${path.join('.')} fehlt.`)
  }
  node[last] = value
}

/**
 * @param {any} obj
 * @param {(string | number)[]} path
 * @returns {unknown}
 */
function getPath(obj, path) {
  let node = obj
  for (const key of path) node = node?.[key]
  return node
}

/**
 * Hebt die Version in den Texten der fünf Dateien. Rein, ohne Dateizugriff.
 *
 * Ersetzt wird im Text, damit die Formatierung bleibt. Danach prüft die
 * Funktion am geparsten JSON: Nur die Versionsfelder haben sich geändert.
 * Sonst wirft sie, und das Skript schreibt keine Datei.
 *
 * @param {Record<string, string>} files Pfad → Inhalt
 * @param {string} from
 * @param {string} to
 * @returns {Record<string, string>}
 */
export function bumpVersionFiles(files, from, to) {
  /** @type {Record<string, string>} */
  const result = {}
  for (const file of VERSION_FILES) {
    const text = files[file]
    if (text === undefined) throw new Error(`${file}: Datei fehlt.`)

    if (file === 'README.md') {
      const pin = `quality#v${from}`
      if (!text.includes(pin)) throw new Error(`${file}: kein Pin ${pin} gefunden.`)
      result[file] = text.replaceAll(pin, `quality#v${to}`)
      continue
    }

    const fields = JSON_FIELDS[file] ?? []
    const original = JSON.parse(text)
    for (const path of fields) {
      if (getPath(original, path) !== from) {
        throw new Error(`${file}: ${path.join('.')} ist nicht ${from}.`)
      }
    }

    // Die Versionsfelder stehen in allen vier JSON-Dateien vor jedem anderen
    // "version"-Feld. Darum genügen die ersten n Treffer. Die Prüfung unten
    // fängt ab, wenn das einmal nicht mehr stimmt.
    let left = fields.length
    const bumped = text.replace(
      new RegExp(`"version": "${from.replaceAll('.', '\\.')}"`, 'g'),
      (hit) => {
        if (left === 0) return hit
        left--
        return `"version": "${to}"`
      },
    )

    const expected = structuredClone(original)
    for (const path of fields) setPath(expected, path, to)
    if (!isDeepStrictEqual(JSON.parse(bumped), expected)) {
      throw new Error(`${file}: Die Ersetzung trifft nicht genau die Versionsfelder.`)
    }
    result[file] = bumped
  }
  return result
}

/**
 * @param {string[]} args
 * @param {string} root
 * @returns {string}
 */
function gitIn(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}

/**
 * Prüft den Stand des Repos und gibt die SHA von HEAD zurück. Wirft mit einer
 * lesbaren Meldung, wenn eine Bedingung fehlt oder git scheitert.
 *
 * Der Branch muss main sein, nicht nur die SHA gleich. Sonst landet der
 * Versions-Commit auf einem anderen Branch oder einem losen HEAD, und der
 * Push von main nimmt ihn nicht mit.
 *
 * @param {(args: string[]) => string} git
 * @returns {string}
 */
function checkRepo(git) {
  /** @param {string[]} args */
  const run = (args) => {
    try {
      return git(args)
    } catch (err) {
      const failure = /** @type {Error & { stderr?: string }} */ (err)
      throw new Error(
        `git ${args.join(' ')} schlägt fehl: ${failure.stderr?.trim() || failure.message}`,
      )
    }
  }

  if (run(['status', '--porcelain']) !== '') {
    throw new Error('Das Arbeitsverzeichnis hat offene Änderungen.')
  }
  let branch = ''
  try {
    branch = git(['symbolic-ref', '--quiet', '--short', 'HEAD'])
  } catch {
    // Loser HEAD: kein Branch.
  }
  if (branch !== 'main') {
    throw new Error(`Ausgecheckt ist ${branch || 'ein loser HEAD'}, nicht main.`)
  }
  run(['fetch', '--quiet', 'origin', 'main'])
  const head = run(['rev-parse', 'HEAD'])
  const main = run(['rev-parse', 'origin/main'])
  if (head !== main) {
    throw new Error(
      `HEAD (${head.slice(0, 7)}) ist nicht origin/main (${main.slice(0, 7)}). ` +
        'Geprüft wird nur, was auf main liegt.',
    )
  }
  return head
}

/**
 * @typedef {object} ReleaseOptions
 * @property {string} root
 * @property {string} version
 * @property {Record<string, string | undefined>} [env]
 * @property {(options: import('./deploy-check.mjs').DeployCheckOptions) => Promise<number>} [deployCheck]
 * @property {(args: string[]) => string} [git]
 * @property {{ out: (s: string) => void, err: (s: string) => void }} [write]
 */

/**
 * Prüft den Stand und erzeugt den Versions-Commit.
 *
 * Exit-Codes: 0 committet, 1 blockiert, 2 falscher Aufruf.
 * Bei 1 und 2 ist keine Datei geändert.
 *
 * @param {ReleaseOptions} options
 * @returns {Promise<number>}
 */
export async function runRelease({
  root,
  version,
  env = process.env,
  deployCheck = runDeployCheck,
  git = (args) => gitIn(args, root),
  write = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
}) {
  /** @param {string} message */
  const block = (message) => {
    write.err(`Release abgebrochen: ${message}\nKeine Datei geändert.\n`)
    return 1
  }

  const next = parseVersion(version)
  if (!next) {
    write.err(
      `Aufruf: node scripts/release.mjs <major.minor.patch>, z. B. 1.2.3. Erhalten: "${version}"\n`,
    )
    return 2
  }

  let head
  try {
    head = checkRepo(git)
  } catch (err) {
    return block(/** @type {Error} */ (err).message)
  }

  /** @type {Record<string, string>} */
  const files = Object.fromEntries(
    VERSION_FILES.map((f) => [f, readFileSync(join(root, f), 'utf8')]),
  )
  const current = String(JSON.parse(files['package.json'] ?? '{}').version ?? '')
  const now = parseVersion(current)
  if (!now) return block(`package.json hat keine gültige Version ("${current}").`)
  if (!isHigher(next, now)) return block(`${version} ist nicht höher als ${current}.`)

  let gateLine = ''
  const code = await deployCheck({
    root,
    ref: head,
    env,
    write: { out: (s) => (gateLine += s), err: write.err },
  })
  gateLine = gateLine.trim()
  if (code !== 0) {
    if (gateLine) write.err(`${gateLine}\n`)
    return block(
      code === 2
        ? 'deploy-check kann nichts über origin/main sagen. Prüf gh, Login und Netz.'
        : 'origin/main ist nicht grün: rot, CI läuft noch oder ein Lauf fehlt. ' +
            'Ist main rot, bring zuerst den Fix auf main. Läuft CI noch, warte und starte neu.',
    )
  }

  let bumped
  try {
    bumped = bumpVersionFiles(files, current, version)
  } catch (err) {
    return block(/** @type {Error} */ (err).message)
  }

  try {
    for (const [file, text] of Object.entries(bumped)) writeFileSync(join(root, file), text)
    git(['add', '--', ...VERSION_FILES])
    git(['commit', '--quiet', '-m', `build: Version ${version}`, '-m', gateLine])
  } catch (err) {
    // Zurück auf den Stand vor dem Lauf: Index und Dateien. Ein Commit ist
    // nicht entstanden, sonst wäre git commit nicht gescheitert.
    try {
      git(['reset', '--quiet', '--', ...VERSION_FILES])
    } catch {
      // Der Index bleibt dann, wie er ist. Die Dateien setzt die Schleife zurück.
    }
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text)
    return block(`git commit schlägt fehl: ${/** @type {Error} */ (err).message.trim()}`)
  }

  write.out(`${gateLine}\n`)
  write.out(`Versions-Commit ${git(['rev-parse', '--short', 'HEAD'])} für ${version} erstellt.\n`)
  write.out(`Nächste Schritte: Commit-Message ergänzen, pushen, Tag v${version} setzen.\n`)
  return 0
}
