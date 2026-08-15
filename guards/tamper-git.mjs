import { execFileSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { c } from '../lib/run.mjs'
import { EXCEPTION_TRAILER, analyseDiff, findException, parseDiff } from './tamper.mjs'

function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    // Ein leerer Diff liefert Status 0; alles andere ist ein echtes Problem.
    throw new Error(`git ${args.join(' ')} fehlgeschlagen: ${err.stderr?.toString().trim() || err.message}`)
  }
}

/**
 * Prüft die Basis-Referenz vorab, damit statt eines rohen git-Fehlers die
 * häufigste Ursache genannt wird: in CI fehlt fast immer die Historie, weil
 * actions/checkout standardmässig nur einen einzelnen Commit holt.
 */
function assertRevisionExists(ref, root) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: root, stdio: 'ignore' })
  } catch {
    throw new Error(
      `Basis-Referenz "${ref}" ist im Repository nicht auffindbar.\n` +
        `  In CI fehlt dafür meist die Vorgeschichte — actions/checkout braucht dann:\n` +
        `      with:\n        fetch-depth: 0\n` +
        `  Lokal ist die Basis üblicherweise "origin/main".`
    )
  }
}

const MAX_UNTRACKED_BYTES = 512 * 1024

/**
 * Noch nicht erfasste Dateien als "vollständig hinzugefügt" behandeln.
 *
 * `git diff HEAD` kennt sie nicht — ohne diesen Schritt bliebe eine neu
 * angelegte Datei mit Suppression lokal unsichtbar und fiele erst in CI auf.
 * Genau das soll der lokale Lauf ja verhindern.
 */
function untrackedAsAdded(root) {
  const paths = git(['ls-files', '--others', '--exclude-standard'], root).split('\n').filter(Boolean)
  const files = []
  for (const path of paths) {
    try {
      const full = join(root, path)
      if (statSync(full).size > MAX_UNTRACKED_BYTES) continue
      const content = readFileSync(full, 'utf8')
      if (content.includes('\0')) continue // Binärdatei
      files.push({
        path,
        deleted: false,
        added: content.split('\n').map((text, index) => ({ line: index + 1, text })),
      })
    } catch {
      // Unlesbare Datei (Rechte, Symlink ins Leere) übergehen wir still.
    }
  }
  return files
}

/** Ermittelt, ob der Diff von einem Bot stammt (Renovate, Dependabot). */
function isBotAuthor(root, base) {
  const actor = process.env.GITHUB_ACTOR ?? ''
  if (actor.endsWith('[bot]') || actor === 'renovate' || actor === 'dependabot') return true
  if (!base) return false
  try {
    const authors = git(['log', `${base}..HEAD`, '--format=%an <%ae>'], root).split('\n').filter(Boolean)
    return authors.length > 0 && authors.every((a) => /\[bot\]|renovate|dependabot/i.test(a))
  } catch {
    return false
  }
}

/**
 * Führt den Tamper-Check aus.
 * Mit `base` wird der Bereich base...HEAD geprüft (CI, Pull Request),
 * ohne `base` der uncommittete Stand gegen HEAD (lokal, pre-commit).
 */
export function runTamper({ root, base = null, ignorePaths = [], quiet = false }) {
  if (base) assertRevisionExists(base, root)
  const diffText = base
    ? git(['diff', '--unified=0', `${base}...HEAD`], root)
    : git(['diff', '--unified=0', 'HEAD'], root)

  // Nur im lokalen Modus: dort sind neu angelegte Dateien noch nicht erfasst.
  // Mit `base` sind sie längst Teil der Commits und stehen im Diff.
  const files = [...parseDiff(diffText), ...(base ? [] : untrackedAsAdded(root))]
  const botAuthor = isBotAuthor(root, base)
  const findings = analyseDiff(files, { botAuthor, ignorePaths })

  if (findings.length === 0) {
    if (!quiet) process.stdout.write(c.green('✓ Tamper-Check: keine Umgehungsmuster im Diff.\n'))
    return 0
  }

  const messages = base ? git(['log', `${base}..HEAD`, '--format=%B%x00'], root).split('\0') : []
  const exception = findException(messages)

  const write = (s) => process.stdout.write(s)
  write('\n' + c.bold('── Tamper-Check ──') + '\n')

  const byFile = new Map()
  for (const f of findings) {
    if (!byFile.has(f.path)) byFile.set(f.path, [])
    byFile.get(f.path).push(f)
  }
  for (const [path, entries] of byFile) {
    write(`\n${c.bold(path)}\n`)
    for (const e of entries) {
      const where = e.line ? `${c.dim(`:${e.line}`)}` : ''
      write(`  ${exception ? c.yellow('!') : c.red('✗')} ${e.label}${where}\n`)
      if (e.detail) write(`      ${c.dim(e.detail)}\n`)
    }
  }

  if (exception) {
    write(
      c.yellow(`\n${findings.length} Treffer, durchgewinkt per Ausnahme: „${exception}"\n`)
    )
    return 0
  }

  write(c.red(`\n${findings.length} Treffer.`) + ' Diese Änderungen verschieben das Gate, statt es zu erfüllen.\n')
  write(
    c.dim(
      `\nWenn das hier beabsichtigt ist, gehört die Begründung in den Commit:\n` +
        `    ${EXCEPTION_TRAILER} <warum das nötig ist>\n`
    )
  )
  return 1
}
