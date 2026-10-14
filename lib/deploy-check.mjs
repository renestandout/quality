/**
 * `quality deploy-check` — darf dieser Commit ausgeliefert werden?
 *
 * Der Anlass: Am 14.10.2026 prüfte kein Deploy-Weg in adboard, resplan, calcup
 * und rankscan das Gate. `cc --abschliessen` pusht direkt auf main, der
 * CI-Lauf startet erst danach, und die Deploy-Skripte warteten auf nichts.
 * Ein roter oder noch laufender Stand ging so unbemerkt in Produktion.
 *
 * Welche Checks zählen, sagen Branch Protection und Rulesets des
 * Standardbranches. Eine zweite Liste hier liefe früher oder später auseinander.
 *
 * Jede Unklarheit blockiert: kein gh, kein Login, keine Pflicht-Checks, ein
 * unbekannter Ref. Ein Gate, das bei Unklarheit lockerer wird, ist keine
 * Zusage. Für den Notfall gibt es den Override — mit Begründung, laut.
 */
import { execFileSync } from 'node:child_process'
import { c } from './run.mjs'

export const OVERRIDE_ENV = 'QUALITY_DEPLOY_OVERRIDE'
const POLL_MS = 15_000
const PER_PAGE = 100

/** @typedef {'grün' | 'rot' | 'läuft' | 'fehlt'} Verdict */

/**
 * @typedef {object} RequiredCheck
 * @property {string} context
 * @property {number | null} [app_id]
 */

/**
 * @typedef {object} CheckRun
 * @property {string} name
 * @property {string} status
 * @property {string | null} conclusion
 * @property {string | null} [started_at]
 * @property {{ id: number } | null} [app]
 */

/**
 * @typedef {object} CommitStatus
 * @property {string} context
 * @property {string} state
 * @property {string} created_at
 */

/**
 * @typedef {object} CheckVerdict
 * @property {string} context
 * @property {Verdict} verdict
 * @property {string} detail
 */

/**
 * Bindet die Protection den Check an eine App, zählt nur diese. Sonst könnte
 * jeder mit Schreibrecht einen Status gleichen Namens setzen. `-1` und `null`
 * heissen bei GitHub "jede Quelle".
 *
 * @param {RequiredCheck} check
 * @returns {number | null}
 */
function boundApp(check) {
  return typeof check.app_id === 'number' && check.app_id > 0 ? check.app_id : null
}

/**
 * Der jüngste Eintrag nach einem Zeitstempel. Nach einem Re-Run stehen mehrere
 * Läufe desselben Namens da. Massgeblich ist — wie für GitHub — nur der
 * jüngste. Sonst überdeckte ein alter grüner Lauf einen frisch roten.
 *
 * Ein fehlender Zeitstempel zählt als jüngster: Ein Re-Run in der Warteschlange
 * hat noch kein `started_at`, ist aber neuer als jeder abgeschlossene Lauf.
 *
 * @template T
 * @param {T[]} items
 * @param {(item: T) => string | null | undefined} stamp
 * @returns {T | undefined}
 */
function latest(items, stamp) {
  const key = (/** @type {T} */ item) => stamp(item) ?? '￿'
  return items.reduce(
    (best, item) => (best === undefined || key(item) > key(best) ? item : best),
    /** @type {T | undefined} */ (undefined),
  )
}

/**
 * Das Urteil pro Pflicht-Check. Nur `success` ist grün. GitHub lässt auch
 * `skipped` und `neutral` als bestanden gelten — ein übersprungenes Gate hat
 * aber nichts geprüft.
 *
 * @param {RequiredCheck[]} required
 * @param {CheckRun[]} checkRuns
 * @param {CommitStatus[]} statuses
 * @returns {CheckVerdict[]}
 */
export function evaluate(required, checkRuns, statuses) {
  return required.map((check) => {
    const app = boundApp(check)
    const latestRun = latest(
      checkRuns.filter((r) => r.name === check.context && (app === null || r.app?.id === app)),
      (r) => r.started_at,
    )
    if (latestRun) {
      if (latestRun.status !== 'completed')
        return { context: check.context, verdict: 'läuft', detail: latestRun.status }
      return latestRun.conclusion === 'success'
        ? { context: check.context, verdict: 'grün', detail: 'success' }
        : {
            context: check.context,
            verdict: 'rot',
            detail: latestRun.conclusion ?? 'ohne Ergebnis',
          }
    }

    // Ein klassischer Status trägt keine App. Ist eine verlangt, zählt er nicht.
    if (app === null) {
      const latestStatus = latest(
        statuses.filter((s) => s.context === check.context),
        (s) => s.created_at,
      )
      if (latestStatus) {
        if (latestStatus.state === 'success')
          return { context: check.context, verdict: 'grün', detail: 'success' }
        if (latestStatus.state === 'pending')
          return { context: check.context, verdict: 'läuft', detail: 'pending' }
        return { context: check.context, verdict: 'rot', detail: latestStatus.state }
      }
    }
    return { context: check.context, verdict: 'fehlt', detail: 'kein Lauf für diesen Commit' }
  })
}

/**
 * Die Pflicht-Checks aus zwei Quellen: der klassischen Branch Protection und
 * den Rulesets. GitHub verlangt beide, also zählen beide. Ein Check, den beide
 * nennen, zählt einmal.
 *
 * Ältere Protections füllen nur `contexts`, ohne App-Bindung.
 *
 * @param {any} protection  `.protection` aus `repos/<o>/<r>/branches/<b>`
 * @param {any} rules       Antwort von `repos/<o>/<r>/rules/branches/<b>`
 * @returns {RequiredCheck[]}
 */
export function requiredChecks(protection, rules) {
  const status = protection?.required_status_checks
  /** @type {RequiredCheck[]} */
  const classic =
    status?.checks?.length > 0
      ? status.checks
      : (status?.contexts ?? []).map((/** @type {string} */ context) => ({
          context,
          app_id: null,
        }))
  /** @type {RequiredCheck[]} */
  const fromRules = (Array.isArray(rules) ? rules : [])
    .filter((rule) => rule?.type === 'required_status_checks')
    .flatMap((rule) => rule.parameters?.required_status_checks ?? [])
    .map((/** @type {{ context: string, integration_id?: number }} */ check) => ({
      context: check.context,
      app_id: check.integration_id ?? null,
    }))

  /** @type {Map<string, RequiredCheck>} */
  const unique = new Map()
  for (const check of [...classic, ...fromRules]) {
    unique.set(`${check.context}\u0000${check.app_id ?? ''}`, check)
  }
  return [...unique.values()]
}

/**
 * `owner/repo` aus der URL von origin. Nur GitHub — für alles andere gibt es
 * keine Check-Runs, die man fragen könnte.
 *
 * @param {string} url
 * @returns {string | null}
 */
export function parseRepoSlug(url) {
  const match = url.trim().match(/github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?\/?$/)
  return match ? `${match[1]}/${match[2]}` : null
}

/**
 * Der Standardweg zur API: `gh api`. gh bringt Login und Token schon mit, und
 * die Deploy-Skripte nutzen es ohnehin.
 *
 * @param {string} path
 * @returns {any}
 */
function ghApi(path) {
  try {
    return JSON.parse(
      execFileSync('gh', ['api', path], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        maxBuffer: 32 * 1024 * 1024,
      }),
    )
  } catch (err) {
    const failure = /** @type {Error & { code?: string, stderr?: string }} */ (err)
    if (failure.code === 'ENOENT') throw new Error('gh ist nicht installiert.')
    throw new Error(`gh api ${path}: ${failure.stderr?.trim() || failure.message}`)
  }
}

/**
 * GitHub kennt die SHA nicht — der Commit ist nicht gepusht. Gemessen am
 * 14.10.2026: HTTP 422 mit "No commit found for SHA". Beide Merkmale zählen,
 * damit eine geänderte Formulierung nicht zur Störung wird.
 *
 * @param {string} message
 * @returns {boolean}
 */
function isUnknownCommit(message) {
  return /No commit found for SHA|\(HTTP 422\)/.test(message)
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
 * Alle Seiten einer Liste. Ein Commit mit vielen Jobs hat schnell mehr als
 * eine Seite, und der fehlende Lauf stünde dann auf Seite zwei.
 *
 * @template T
 * @param {(path: string) => any} api
 * @param {string} path
 * @param {(body: any) => T[]} items
 * @returns {T[]}
 */
function allPages(api, path, items) {
  /** @type {T[]} */
  const all = []
  for (let page = 1; ; page++) {
    const batch = items(api(`${path}?per_page=${PER_PAGE}&page=${page}`))
    all.push(...batch)
    if (batch.length < PER_PAGE) return all
  }
}

/**
 * @param {CheckVerdict[]} verdicts
 * @param {(s: string) => void} err
 */
function report(verdicts, err) {
  const color = {
    grün: c.green,
    rot: c.red,
    läuft: c.yellow,
    fehlt: c.yellow,
  }
  for (const v of verdicts) {
    err(`  ${color[v.verdict](v.verdict.padEnd(5))}  ${v.context}  ${c.dim(v.detail)}\n`)
  }
}

/**
 * @typedef {object} DeployCheckOptions
 * @property {string} root
 * @property {string | null} [ref]
 * @property {number} [waitSeconds]
 * @property {Record<string, string | undefined>} [env]
 * @property {(path: string) => any} [api]
 * @property {(args: string[]) => string} [git]
 * @property {() => number} [now]
 * @property {(ms: number) => void | Promise<void>} [sleep]
 * @property {{ out: (s: string) => void, err: (s: string) => void }} [write]
 */

/**
 * Prüft den Commit und gibt den Exit-Code zurück: 0 grün, 1 blockiert,
 * 2 keine Aussage möglich. Mit Override immer 0.
 *
 * Auf stdout steht genau eine Zeile im festen Format. Die Deploy-Skripte
 * übernehmen sie ins Log oder in die Tag-Nachricht.
 *
 * @param {DeployCheckOptions} options
 * @returns {Promise<number>}
 */
export async function runDeployCheck({
  root,
  ref = null,
  waitSeconds = 0,
  env = process.env,
  api = ghApi,
  git = (args) => gitIn(args, root),
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  write = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) },
}) {
  const target = ref ?? 'HEAD'
  const override = (env[OVERRIDE_ENV] ?? '').trim()
  let sha = target

  /**
   * @param {number} code
   * @param {string} summary
   */
  const finish = (code, summary) => {
    if (code === 0) {
      write.out(`deploy-check: ${summary}\n`)
      return 0
    }
    if (override) {
      write.err(
        c.yellow(
          `\nOVERRIDE: Das Gate ist nicht grün, das Deploy läuft trotzdem.\n` +
            `  Begründung (${OVERRIDE_ENV}): ${override}\n`,
        ),
      )
      write.out(`deploy-check: override ${sha} — ${override}\n`)
      return 0
    }
    write.out(`deploy-check: blockiert ${sha} — ${summary}\n`)
    return code
  }

  /** @param {string} message */
  const undetermined = (message) => {
    write.err(c.red(`Keine Aussage über ${target} möglich: ${message}\n`))
    return finish(2, 'keine Aussage möglich')
  }

  try {
    sha = git(['rev-parse', '--verify', '--quiet', `${target}^{commit}`])
  } catch {
    return undetermined(`"${target}" ist im Repository nicht auffindbar.`)
  }

  let slug
  try {
    slug = parseRepoSlug(git(['remote', 'get-url', 'origin']))
  } catch {
    slug = null
  }
  if (!slug) return undetermined('origin zeigt nicht auf ein GitHub-Repository.')

  let required
  let branch
  try {
    branch = String(api(`repos/${slug}`).default_branch)
    required = requiredChecks(
      api(`repos/${slug}/branches/${branch}`).protection,
      api(`repos/${slug}/rules/branches/${branch}`),
    )
  } catch (err) {
    return undetermined(err instanceof Error ? err.message : String(err))
  }
  if (required.length === 0) {
    // Ohne Pflicht-Checks gibt es nichts, wofür ein Grün einstehen könnte.
    return undetermined(
      `${branch} hat keine Pflicht-Checks in Branch Protection oder Rulesets. ` +
        'Ohne sie ist nicht festgelegt, was grün sein muss.',
    )
  }
  // Klassische Statuses zählen nur für Checks ohne App-Bindung. Sind alle
  // gebunden, spart das je Abfrage einen Aufruf und Rate-Limit.
  const needsStatuses = required.some((check) => boundApp(check) === null)

  const deadline = now() + waitSeconds * 1000
  for (;;) {
    let verdicts
    try {
      const checkRuns = allPages(
        api,
        `repos/${slug}/commits/${sha}/check-runs`,
        (body) => /** @type {CheckRun[]} */ (body.check_runs ?? []),
      )
      const statuses = needsStatuses
        ? allPages(
            api,
            `repos/${slug}/commits/${sha}/statuses`,
            (body) => /** @type {CommitStatus[]} */ (body ?? []),
          )
        : []
      verdicts = evaluate(required, checkRuns, statuses)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // Ein unbekannter Commit ist eine klare Aussage — es gibt noch keinen
      // Lauf —, keine Störung. Mit --wait kann der Push noch kommen.
      if (!isUnknownCommit(message)) return undetermined(message)
      verdicts = evaluate(required, [], [])
    }

    const open = verdicts.filter((v) => v.verdict !== 'grün')
    const failed = open.some((v) => v.verdict === 'rot')
    const remaining = deadline - now()

    if (open.length === 0 || failed || remaining <= 0) {
      write.err(
        `${c.bold('quality deploy-check')} ${sha.slice(0, 12)} (${slug}, Pflicht-Checks von ${branch})\n`,
      )
      report(verdicts, write.err)
      if (open.length === 0)
        return finish(0, `grün ${sha} ${verdicts.map((v) => v.context).join(',')}`)
      if (!failed && waitSeconds > 0) write.err(c.dim(`  Frist von ${waitSeconds} s abgelaufen.\n`))
      if (open.every((v) => v.verdict === 'fehlt'))
        write.err(c.dim('  Ist der Commit gepusht? Ohne Push gibt es keinen CI-Lauf.\n'))
      return finish(1, open.map((v) => `${v.context} ${v.verdict}`).join(', '))
    }

    write.err(c.dim(`warte auf ${open.map((v) => `${v.context} (${v.verdict})`).join(', ')} …\n`))
    await sleep(Math.min(POLL_MS, remaining))
  }
}
