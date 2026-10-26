import { execFileSync, spawnSync } from 'node:child_process'
import { readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { c } from '../lib/run.mjs'
import {
  COMPOSER_LOCKFILE,
  EXCEPTION_TRAILER,
  NPM_LOCKFILE,
  SOFT_LOCALLY,
  analyseDiff,
  composerLockOnlyRehashes,
  findException,
  lockfileOnlyBumpsOwnVersion,
  parseDiff,
} from './tamper.mjs'

/** @import { DiffFile, Finding } from './tamper.mjs' */

/**
 * @param {string[]} args
 * @param {string} cwd
 * @returns {string}
 */
function git(args, cwd) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  } catch (err) {
    // execFileSync wirft einen Error, der die Ausgabe von git in `stderr` trägt.
    const failure = /** @type {Error & { stderr?: Buffer | string }} */ (err)
    // Ein leerer Diff liefert Status 0; alles andere ist ein echtes Problem.
    throw new Error(
      `git ${args.join(' ')} fehlgeschlagen: ${failure.stderr?.toString().trim() || failure.message}`,
    )
  }
}

/**
 * Prüft die Basis-Referenz vorab, damit statt eines rohen git-Fehlers die
 * häufigsten Ursachen genannt werden: in CI fehlt meist die Historie, weil
 * actions/checkout standardmässig nur einen einzelnen Commit holt — und nach
 * einem Force-Push existiert der Stand vor dem Push nicht mehr.
 *
 * @param {string} ref
 * @param {string} root
 */
export function assertRevisionExists(ref, root) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], {
      cwd: root,
      stdio: 'ignore',
    })
  } catch {
    throw new Error(
      `Basis-Referenz "${ref}" ist im Repository nicht auffindbar.\n` +
        `  In CI fehlt dafür meist die Vorgeschichte — actions/checkout braucht dann:\n` +
        `      with:\n        fetch-depth: 0\n` +
        `  Beim Push auf den Standardbranch ist die Basis der Stand davor\n` +
        `  (github.event.before). Nach einem Force-Push gibt es den nicht mehr:\n` +
        `  die Historie ist umgeschrieben, der alte Stand nicht mehr erreichbar.\n` +
        `  Lokal ist die Basis üblicherweise "origin/main".`,
    )
  }
}

/**
 * Der Null-SHA: nur Nullen statt einer Commit-Kennung. GitHub setzt ihn in
 * `github.event.before`, wenn es keinen Stand vor dem Push gibt — beim ersten
 * Push eines Branches. Kurzformen zählen mit, weil git Kennungen auch gekürzt
 * ausgibt.
 *
 * @param {unknown} ref
 * @returns {boolean}
 */
export function isNullRef(ref) {
  return typeof ref === 'string' && /^0{7,40}$/.test(ref.trim())
}

/**
 * Gibt es überhaupt schon einen Commit?
 * Vor dem ersten gibt es kein HEAD — ein frisch angelegtes Repository ist
 * genau der Zustand, in dem ein Projekt das Gate zum ersten Mal aufruft.
 *
 * @param {string} root
 * @returns {boolean}
 */
export function hasCommit(root) {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', 'HEAD'], {
      cwd: root,
      stdio: 'ignore',
    })
    return true
  } catch {
    return false
  }
}

const MAX_UNTRACKED_BYTES = 512 * 1024

/**
 * Noch nicht erfasste Dateien als "vollständig hinzugefügt" behandeln.
 *
 * `git diff HEAD` kennt sie nicht — ohne diesen Schritt bliebe eine neu
 * angelegte Datei mit Suppression lokal unsichtbar und fiele erst in CI auf.
 * Genau das soll der lokale Lauf ja verhindern.
 *
 * @param {string} root
 * @param {{ includeCached?: boolean }} [options]
 * @returns {DiffFile[]}
 */
function untrackedAsAdded(root, { includeCached = false } = {}) {
  const args = ['ls-files', '--others', '--exclude-standard']
  if (includeCached) args.push('--cached')
  const paths = git(args, root).split('\n').filter(Boolean)
  /** @type {DiffFile[]} */
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

/**
 * Liest eine Datei in einem bestimmten Commit. `null`, wenn es sie dort nicht gibt.
 *
 * @param {string} root
 * @param {string} rev
 * @param {string} path
 * @returns {string | null}
 */
function showAt(root, rev, path) {
  try {
    return execFileSync('git', ['show', `${rev}:${path}`], {
      cwd: root,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch {
    return null
  }
}

/**
 * Markiert jedes Lockfile, das nur einen Versionssprung des eigenen Pakets
 * abbildet. Dafür liest sie beide Fassungen und übergibt sie dem JSON-Vergleich.
 * Bei composer.lock liest sie zusätzlich beide Fassungen des composer.json
 * im selben Verzeichnis.
 *
 * Die Fassungen passen zum geprüften Diff: vorher der Stand im Commit
 * `before`, nachher der Stand im Commit `after`. Ohne `after` gilt das
 * Arbeitsverzeichnis. Fehlt eine Fassung, bleibt die Datei unmarkiert und
 * die Regel meldet wie bisher.
 *
 * @param {DiffFile[]} files
 * @param {string} root
 * @param {string} before
 * @param {string | null} after
 * @returns {DiffFile[]}
 */
function markOwnVersionBumps(files, root, before, after) {
  return files.map((file) => {
    const npm = NPM_LOCKFILE.test(file.path)
    const composer = COMPOSER_LOCKFILE.test(file.path)
    if (file.deleted || (!npm && !composer)) return file

    /** @param {string} path */
    const versions = (path) => {
      if (after) return { before: showAt(root, before, path), after: showAt(root, after, path) }
      let current
      try {
        current = readFileSync(join(root, path), 'utf8')
      } catch {
        current = null
      }
      return { before: showAt(root, before, path), after: current }
    }

    const lock = versions(file.path)
    let ownVersionOnly
    if (npm) {
      ownVersionOnly = lockfileOnlyBumpsOwnVersion(lock.before, lock.after)
    } else {
      const manifest = versions(join(dirname(file.path), 'composer.json'))
      ownVersionOnly = composerLockOnlyRehashes({
        lockBefore: lock.before,
        lockAfter: lock.after,
        manifestBefore: manifest.before,
        manifestAfter: manifest.after,
      })
    }
    return ownVersionOnly ? { ...file, ownVersionOnly: true } : file
  })
}

/**
 * Trägt der Merge-Commit eine eigene Änderung?
 *
 * `git show --remerge-diff` vergleicht den Merge-Commit mit dem Ergebnis,
 * das git selbst erzeugt hätte. Ein sauberer Merge liefert deshalb nichts.
 * Jede Konfliktlösung und jede Zusatzänderung im Merge-Commit erscheint.
 *
 * `--cc` reicht dafür nicht. Es blendet Stellen aus, an denen das Ergebnis
 * einer Elternseite gleicht. Ein Konflikt, gelöst mit der Fassung der
 * Bot-Seite, bliebe so unsichtbar.
 *
 * Braucht git 2.36. Ein älteres git scheitert hier; `isBotAuthor` fängt den
 * Fehler und meldet keinen Bot. Der Check bleibt also streng.
 *
 * Kann git kein temporäres Objektverzeichnis anlegen (etwa im ddev-Container),
 * meldet es das nur auf stderr und endet trotzdem mit Exit 0. stdout bleibt
 * leer, der Merge sähe sauber aus. Deshalb gilt jede Ausgabe auf stderr als
 * Fehler.
 *
 * @param {string} root
 * @param {string} sha
 * @returns {boolean}
 */
function mergeHasOwnChange(root, sha) {
  const args = ['show', '--remerge-diff', '--format=', sha]
  const result = spawnSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
  const stderr = result.stderr?.trim() ?? ''
  if (result.error || result.status !== 0 || stderr !== '') {
    throw new Error(
      `git ${args.join(' ')} fehlgeschlagen: ${stderr || result.error?.message || `Status ${result.status}`}`,
    )
  }
  return result.stdout.trim() !== ''
}

/**
 * Was GitHub über einen Commit weiss.
 *
 * `verified` und `reason` stammen aus der Signaturprüfung. `committer` und
 * `author` sind GitHub-Logins. GitHub leitet sie aus den E-Mail-Adressen im
 * Commit ab; für sich allein beweisen sie deshalb nichts.
 *
 * @typedef {{ verified: boolean, reason: string, committer: string, author: string }} CommitIdentity
 */

/**
 * Liefert, was GitHub über einen Commit weiss. Wirft, wenn die Antwort fehlt.
 *
 * @typedef {(sha: string) => CommitIdentity} CommitOf
 */

/**
 * Ein GitHub-Login, der einem Bot gehört.
 * GitHub vergibt Logins mit `[bot]` nur an Apps. Den Wert setzt GitHub, nicht
 * der Autor eines Commits.
 *
 * @param {string} login
 * @returns {boolean}
 */
function isBotLogin(login) {
  return login.endsWith('[bot]') || login === 'renovate' || login === 'dependabot'
}

/**
 * Fragt die GitHub-API nach einem Commit.
 * Läuft in einem eigenen Node-Prozess, weil der Tamper-Check synchron ist.
 * Der Token geht über die Umgebung, nicht über die Kommandozeile.
 *
 * @type {CommitOf}
 */
function githubCommitOf(sha) {
  if (!process.env.GITHUB_TOKEN) throw new Error('GITHUB_TOKEN fehlt')
  if (!process.env.GITHUB_REPOSITORY) throw new Error('GITHUB_REPOSITORY fehlt')
  const script = `
    const api = process.env.GITHUB_API_URL || 'https://api.github.com'
    const res = await fetch(api + '/repos/' + process.env.GITHUB_REPOSITORY + '/commits/' + process.argv[1], {
      headers: {
        authorization: 'Bearer ' + process.env.GITHUB_TOKEN,
        accept: 'application/vnd.github+json',
        'x-github-api-version': '2022-11-28',
      },
      signal: AbortSignal.timeout(15000),
    })
    if (!res.ok) {
      process.stderr.write('HTTP ' + res.status)
      process.exit(1)
    }
    const c = await res.json()
    process.stdout.write(JSON.stringify({
      verified: c.commit?.verification?.verified === true,
      reason: c.commit?.verification?.reason ?? '',
      committer: c.committer?.login ?? '',
      author: c.author?.login ?? '',
    }))
  `
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script, sha], {
    encoding: 'utf8',
    timeout: 20000,
  })
  if (result.error || result.status !== 0) {
    const reason = result.stderr?.trim() || result.error?.message || `Status ${result.status}`
    throw new Error(`GitHub-API nicht erreichbar (${reason})`)
  }
  return /** @type {CommitIdentity} */ (JSON.parse(result.stdout))
}

/**
 * Die Bots, deren Commits die Ausnahme tragen. Jedes andere `[bot]` fehlt
 * mit Absicht: github-actions etwa schreibt jeder, der einen Workflow pusht.
 */
const SIGNING_BOTS = new Set(['dependabot[bot]', 'renovate[bot]'])

/**
 * Hat GitHub den Commit im Namen eines Bots erzeugt?
 *
 * Login, Committer und E-Mail lassen sich frei setzen. Nur die Signatur nicht:
 * GitHub signiert einen Commit bloss, wenn der Autor auch der ist, der ihn
 * erzeugt. Ein Mensch mit gefälschtem Autor erhält `unsigned`, auch über die
 * Contents-API und auch mit GITHUB_TOKEN (Experiment vom 2026-10-26).
 *
 * @param {CommitIdentity} commit
 * @returns {boolean}
 */
function signedByBot(commit) {
  return (
    commit.verified &&
    commit.reason === 'valid' &&
    commit.committer === 'web-flow' &&
    SIGNING_BOTS.has(commit.author)
  )
}

/**
 * Ermittelt, ob der Diff von einem Bot stammt (Renovate, Dependabot).
 *
 * Der Git-Autor allein reicht dafür nicht. Ihn setzt jeder selbst, etwa mit
 * `git commit --author='dependabot[bot] <…>'`. Er ist deshalb nur die
 * Vorbedingung. Jeden Commit bestätigt danach GitHub einzeln.
 *
 * Ein Merge-Commit ohne eigene Änderung trägt nur Inhalt seiner Eltern. Er
 * zählt deshalb nicht als Autor. Ein Merge-Commit mit eigener Änderung zählt
 * wie jeder andere Commit. Ein pauschales `--no-merges` liesse diese Änderung
 * ungeprüft durch.
 *
 * Ohne `base` gibt es keine Commits zu prüfen. Dann zählt nur `GITHUB_ACTOR`.
 *
 * Fehlt die Bestätigung, entfällt die Ausnahme, und `unconfirmed` nennt den
 * Grund. Ein Bot-Diff wird dann rot statt still grün.
 *
 * @param {string} root
 * @param {string | null} base
 * @param {CommitOf} commitOf
 * @returns {{ bot: boolean, unconfirmed: string | null }}
 */
function isBotAuthor(root, base, commitOf) {
  const no = { bot: false, unconfirmed: null }
  if (!base) return { bot: isBotLogin(process.env.GITHUB_ACTOR ?? ''), unconfirmed: null }
  /** @type {{ sha: string, author: string }[]} */
  let commits
  try {
    commits = git(['log', `${base}..HEAD`, '--format=%H%x09%P%x09%an <%ae>'], root)
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const [sha = '', parents = '', author = ''] = line.split('\t')
        return { sha, merge: parents.split(' ').length > 1, author }
      })
      .filter(({ sha, merge }) => !merge || mergeHasOwnChange(root, sha))
  } catch {
    return no
  }
  const claimed =
    commits.length > 0 && commits.every(({ author }) => /\[bot\]|renovate|dependabot/i.test(author))
  if (!claimed) return no

  try {
    const unsigned = commits.find(({ sha }) => !signedByBot(commitOf(sha)))
    if (!unsigned) return { bot: true, unconfirmed: null }
    return {
      bot: false,
      unconfirmed: `Commit ${unsigned.sha.slice(0, 8)} hat GitHub nicht für einen Bot signiert`,
    }
  } catch (err) {
    return { bot: false, unconfirmed: /** @type {Error} */ (err).message }
  }
}

/**
 * Der gemeinsame Stand von `base` und HEAD.
 * Fehlt er, ist der Bereich base...HEAD nicht bestimmbar. Meist fehlt in CI
 * die Vorgeschichte, weil der Checkout flach ist.
 *
 * @param {string} base
 * @param {string} root
 * @returns {string}
 */
function mergeBaseOf(base, root) {
  try {
    return execFileSync('git', ['merge-base', base, 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
  } catch {
    throw noMergeBaseError(base)
  }
}

/**
 * Der Fehler für einen Bereich base...HEAD ohne gemeinsamen Stand.
 *
 * @param {string} base
 * @returns {Error}
 */
export function noMergeBaseError(base) {
  return new Error(
    `Kein gemeinsamer Stand zwischen "${base}" und HEAD — der Bereich ${base}...HEAD ist nicht bestimmbar.\n` +
      '  In CI fehlt dafür meist die Vorgeschichte: actions/checkout braucht dann fetch-depth: 0.',
  )
}

/**
 * Läuft der Prozess in CI?
 * GitHub Actions, GitLab und die meisten anderen Dienste setzen CI=true.
 * Jenkins setzt die Variable nicht. "false" und "0" gelten als lokal.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function isCi(env) {
  const value = env.CI?.trim() ?? ''
  return value !== '' && value !== 'false' && value !== '0'
}

/**
 * Führt den Tamper-Check aus. Er prüft zwei Teile getrennt.
 *
 * Der committete Teil ist der Bereich base...HEAD, nur mit `base` — in CI der
 * Zielbranch eines Pull Requests oder der Stand vor einem Push. Hier gelten
 * alle Regeln, der Trailer und die Bot-Ausnahme.
 *
 * Der uncommittete Teil ist HEAD gegen das Arbeitsverzeichnis, samt neuer
 * Dateien. Hier gelten die lokalen Regeln: einige Funde sind nur Hinweise,
 * und weder Trailer noch Bot-Ausnahme greifen. Mit `base` lässt
 * `worktree: false` diesen Teil aus. Das braucht CI: dort laufen vorher Build
 * und Tests, und deren Ausgabe hat kein Autor geschrieben. Ohne `base` ist
 * dieser Teil die ganze Prüfung und läuft immer.
 *
 * `commitOf` fragt, was GitHub über einen Commit weiss. Ohne Angabe fragt der
 * Check die GitHub-API. Tests geben eine feste Antwort vor.
 *
 * @param {{ root: string, base?: string | null, worktree?: boolean, ignorePaths?: string[], quiet?: boolean, commitOf?: CommitOf }} options
 * @returns {number}
 */
export function runTamper({
  root,
  base = null,
  worktree = true,
  ignorePaths = [],
  quiet = false,
  commitOf = githubCommitOf,
}) {
  // Beim ersten Push eines Branches gibt es keinen Stand davor. Sauber
  // überspringen, statt an git zu scheitern — und nicht auf den lokalen Modus
  // zurückfallen: der prüfte in CI den uncommitteten Stand und meldete grün,
  // ohne einen einzigen Commit gesehen zu haben.
  if (isNullRef(base)) {
    if (!quiet) {
      process.stdout.write(
        c.dim('Tamper-Check übersprungen: kein Stand vor diesem Push (Null-SHA als Basis).\n'),
      )
    }
    return 0
  }
  if (base) assertRevisionExists(base, root)
  // Ohne ersten Commit gibt es kein HEAD: dann ist der gesamte Stand neu.
  const committed = hasCommit(root)
  const { bot: botAuthor, unconfirmed } = isBotAuthor(root, base, commitOf)
  if (unconfirmed && !quiet) {
    process.stdout.write(
      c.yellow(
        `Tamper-Check: Bot-Autor nicht bestätigt (${unconfirmed}). Die Bot-Ausnahme entfällt.\n`,
      ),
    )
  }

  /** @type {Finding[]} */
  let branchFindings = []
  if (base) {
    const mergeBase = mergeBaseOf(base, root)
    const diffText = git(['diff', '--unified=0', mergeBase, 'HEAD'], root)
    const files = markOwnVersionBumps(parseDiff(diffText), root, mergeBase, 'HEAD')
    branchFindings = analyseDiff(files, { botAuthor, ignorePaths })
  }

  /** @type {DiffFile[]} */
  let worktreeFiles = []
  if (!base || worktree) {
    const diffText = committed ? git(['diff', '--unified=0', 'HEAD'], root) : ''
    // `git diff` kennt neu angelegte, noch nicht erfasste Dateien nicht.
    worktreeFiles = [
      ...markOwnVersionBumps(parseDiff(diffText), root, 'HEAD', null),
      ...untrackedAsAdded(root, { includeCached: !committed }),
    ]
  }
  // Die Commits eines Bots sagen nichts über Änderungen, die noch in keinem
  // Commit stehen. Ohne `base` zählt nur GITHUB_ACTOR, wie bisher.
  const worktreeAll = analyseDiff(worktreeFiles, {
    botAuthor: base ? false : botAuthor,
    ignorePaths,
  })

  /*
   * Lokal wiegen zwei Regeln leichter als in CI.
   *
   * Eine geänderte Gate-Konfiguration oder ein neues Paket ist meist Arbeit
   * des Menschen — beim Onboarding legt man quality.yml überhaupt erst an.
   * Lokal gibt es aber noch keinen Commit und damit keinen Trailer, mit dem
   * sich das durchwinken liesse: das Gate wäre unpassierbar, bevor das
   * Projekt es je benutzt hat. Und was der Agent hier anrichten könnte,
   * verhindert bereits der PreToolUse-Hook.
   *
   * Die Regeln, die Agentenverhalten betreffen — Suppressions, stillgelegte
   * oder gelöschte Tests — blockieren auch lokal.
   */
  const worktreeFindings = worktreeAll.filter((f) => !SOFT_LOCALLY.has(f.rule))
  const informational = worktreeAll.filter((f) => SOFT_LOCALLY.has(f.rule))

  const hint = () =>
    c.dim(
      `Tamper-Check: ${informational.length} Hinweis(e) ohne Blockade — ` +
        `${informational.map((f) => f.path).join(', ')}. In CI zählen sie.\n`,
    )

  if (branchFindings.length === 0 && worktreeFindings.length === 0) {
    if (!base && worktreeFiles.length === 0 && !quiet) {
      // Ohne --base sieht der Check nur den uncommitteten Stand. In CI ist er
      // leer: «keine Umgehungsmuster» wäre dort eine Aussage ohne Prüfung.
      process.stdout.write(
        c.dim(
          'Tamper-Check: kein uncommitteter Stand — nichts geprüft. ' +
            'Committete Änderungen prüft --base <ref>.\n',
        ),
      )
    } else if (informational.length > 0 && !quiet) {
      process.stdout.write(hint())
    } else if (!quiet) {
      process.stdout.write(c.green('✓ Tamper-Check: keine Umgehungsmuster im Diff.\n'))
    }
    return 0
  }

  const messages = base ? git(['log', `${base}..HEAD`, '--format=%B%x00'], root).split('\0') : []
  const exception = findException(messages)
  // Der Trailer begründet nur, was in einem Commit steht.
  const excused = exception ? branchFindings.length : 0
  const blocking = [...(exception ? [] : branchFindings), ...worktreeFindings]

  const write = (/** @type {string} */ s) => process.stdout.write(s)
  write('\n' + c.bold('── Tamper-Check ──') + '\n')

  /** @type {Map<string, { finding: Finding, excused: boolean }[]>} */
  const byFile = new Map()
  const entries = [
    ...branchFindings.map((finding) => ({ finding, excused: Boolean(exception) })),
    ...worktreeFindings.map((finding) => ({ finding, excused: false })),
  ]
  for (const entry of entries) {
    const { path } = entry.finding
    if (!byFile.has(path)) byFile.set(path, [])
    // Die Zeile darüber legt den Eintrag an, falls er fehlt.
    const list = /** @type {{ finding: Finding, excused: boolean }[]} */ (byFile.get(path))
    list.push(entry)
  }
  for (const [path, entries] of byFile) {
    write(`\n${c.bold(path)}\n`)
    for (const { finding: e, excused: ok } of entries) {
      const where = e.line ? `${c.dim(`:${e.line}`)}` : ''
      write(`  ${ok ? c.yellow('!') : c.red('✗')} ${e.label}${where}\n`)
      if (e.detail) write(`      ${c.dim(e.detail)}\n`)
    }
  }

  if (excused > 0) {
    write(c.yellow(`\n${excused} Treffer, durchgewinkt per Ausnahme: „${exception}"\n`))
  }
  if (informational.length > 0) write('\n' + hint())
  if (blocking.length === 0) return 0

  write(
    c.red(`\n${blocking.length} Treffer.`) +
      ' Diese Änderungen verschieben das Gate, statt es zu erfüllen.\n',
  )
  write(
    c.dim(
      `\nWenn das hier beabsichtigt ist, gehört die Begründung in den Commit:\n` +
        `    ${EXCEPTION_TRAILER} <warum das nötig ist>\n`,
    ),
  )
  return 1
}
