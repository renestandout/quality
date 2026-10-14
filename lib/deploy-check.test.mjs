/**
 * `quality deploy-check` — ob ein Commit ausgeliefert werden darf.
 *
 * Der Anlass: Am 14.10.2026 prüfte kein Deploy-Weg in adboard, resplan, calcup
 * und rankscan, ob das Gate auf dem ausgelieferten Commit grün ist. Der Push
 * auf main geschieht vor dem CI-Lauf, und das Deploy wartete auf nichts.
 *
 * Die GitHub-API ist hier eine Attrappe. Gefragt ist nicht, ob gh funktioniert,
 * sondern wie das Kommando die Antworten wertet — und dass jede Unklarheit
 * blockiert.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { evaluate, parseRepoSlug, requiredChecks, runDeployCheck } from './deploy-check.mjs'

const SHA = 'a'.repeat(40)
const ACTIONS = 15368

/**
 * @param {string} name
 * @param {string} status
 * @param {string | null} conclusion
 * @param {string} [startedAt]
 * @param {number} [appId]
 */
const run = (name, status, conclusion, startedAt = '2026-10-14T10:00:00Z', appId = ACTIONS) => ({
  name,
  status,
  conclusion,
  started_at: startedAt,
  app: { id: appId },
})

/** @param {string} context */
const required = (context, appId = /** @type {number | null} */ (ACTIONS)) => ({
  context,
  app_id: appId,
})

test('evaluate: grün nur bei abgeschlossenem Lauf mit Erfolg', () => {
  const urteil = evaluate(
    [required('quality'), required('tests'), required('build'), required('lint')],
    [
      run('quality', 'completed', 'success'),
      run('tests', 'completed', 'failure'),
      run('build', 'in_progress', null),
    ],
    [],
  )
  assert.deepEqual(
    urteil.map((u) => [u.context, u.verdict]),
    [
      ['quality', 'grün'],
      ['tests', 'rot'],
      ['build', 'läuft'],
      ['lint', 'fehlt'],
    ],
  )
})

// GitHub lässt `skipped` und `neutral` als bestanden gelten. Ein übersprungenes
// Gate hat aber nichts geprüft — das ist für ein Deploy keine Zusage.
test('evaluate: übersprungen oder neutral ist nicht grün', () => {
  const urteil = evaluate(
    [required('quality'), required('tests')],
    [run('quality', 'completed', 'skipped'), run('tests', 'completed', 'neutral')],
    [],
  )
  assert.deepEqual(
    urteil.map((u) => u.verdict),
    ['rot', 'rot'],
  )
})

test('evaluate: nach einem Re-Run zählt nur der jüngste Lauf', () => {
  const runs = [
    run('quality', 'completed', 'success', '2026-10-14T10:00:00Z'),
    run('quality', 'completed', 'failure', '2026-10-14T11:00:00Z'),
  ]
  assert.equal(evaluate([required('quality')], runs, [])[0]?.verdict, 'rot')
  assert.equal(evaluate([required('quality')], [...runs].reverse(), [])[0]?.verdict, 'rot')
})

test('evaluate: ein Lauf einer fremden App mit gleichem Namen zählt nicht', () => {
  const urteil = evaluate(
    [required('quality')],
    [run('quality', 'completed', 'success', undefined, 999)],
    [],
  )
  assert.equal(urteil[0]?.verdict, 'fehlt')
})

test('evaluate: ohne App-Bindung zählt auch ein klassischer Status', () => {
  const statuses = [
    { context: 'ci/legacy', state: 'success', created_at: '2026-10-14T11:00:00Z' },
    { context: 'ci/legacy', state: 'pending', created_at: '2026-10-14T10:00:00Z' },
  ]
  assert.equal(evaluate([required('ci/legacy', null)], [], statuses)[0]?.verdict, 'grün')
  assert.equal(evaluate([required('ci/legacy', -1)], [], statuses)[0]?.verdict, 'grün')
})

test('evaluate: ein klassischer Status zählt nicht, wenn eine App verlangt ist', () => {
  const statuses = [{ context: 'quality', state: 'success', created_at: '2026-10-14T11:00:00Z' }]
  assert.equal(evaluate([required('quality')], [], statuses)[0]?.verdict, 'fehlt')
})

test('parseRepoSlug: https und ssh, mit und ohne .git', () => {
  assert.equal(parseRepoSlug('https://github.com/renestandout/calcup.git'), 'renestandout/calcup')
  assert.equal(parseRepoSlug('https://github.com/renestandout/calcup'), 'renestandout/calcup')
  assert.equal(parseRepoSlug('git@github.com:renestandout/calcup.git'), 'renestandout/calcup')
  assert.equal(parseRepoSlug('ssh://git@github.com/renestandout/calcup.git'), 'renestandout/calcup')
  assert.equal(parseRepoSlug('https://gitlab.com/x/y.git'), null)
})

/**
 * Eine Umgebung für runDeployCheck. `checkRuns` darf eine Funktion sein, damit
 * ein Test das Ergebnis über mehrere Abfragen hinweg ändern kann.
 *
 * @param {object} [o]
 * @param {Array<{context: string, app_id: number | null}>} [o.checks]
 * @param {unknown[] | (() => unknown[])} [o.checkRuns]
 * @param {unknown[]} [o.statuses]
 * @param {Record<string, string>} [o.env]
 * @param {number} [o.waitSeconds]
 * @param {boolean} [o.apiFails]
 * @param {boolean} [o.unbekannterCommit]  GitHub kennt die SHA nicht (nicht gepusht)
 */
function umgebung({
  checks = [required('quality')],
  checkRuns = [],
  statuses = [],
  env = {},
  waitSeconds = 0,
  apiFails = false,
  unbekannterCommit = false,
} = {}) {
  let clock = 0
  /** @type {string[]} */
  const out = []
  /** @type {string[]} */
  const err = []
  /** @type {string[]} */
  const paths = []
  const api = (/** @type {string} */ path) => {
    paths.push(path)
    if (apiFails) throw new Error('gh: HTTP 401 Bad credentials')
    if (path === 'repos/o/r') return { default_branch: 'main' }
    if (path === 'repos/o/r/rules/branches/main') return []
    if (path === 'repos/o/r/branches/main')
      return { protection: { required_status_checks: { checks } } }
    if (unbekannterCommit && path.startsWith(`repos/o/r/commits/${SHA}/`))
      throw new Error(`gh api ${path}: gh: No commit found for SHA: ${SHA} (HTTP 422)`)
    if (path.startsWith(`repos/o/r/commits/${SHA}/check-runs`)) {
      const runs = typeof checkRuns === 'function' ? checkRuns() : checkRuns
      return { total_count: runs.length, check_runs: runs }
    }
    if (path.startsWith(`repos/o/r/commits/${SHA}/statuses`)) return statuses
    throw new Error(`unerwarteter Pfad ${path}`)
  }
  const options = {
    root: '/repo',
    ref: 'HEAD',
    waitSeconds,
    env,
    api,
    git: (/** @type {string[]} */ args) => {
      if (args[0] === 'rev-parse') return SHA
      if (args[0] === 'remote') return 'https://github.com/o/r.git'
      throw new Error(`unerwartet: git ${args.join(' ')}`)
    },
    now: () => clock,
    sleep: (/** @type {number} */ ms) => {
      clock += ms
    },
    write: {
      out: (/** @type {string} */ s) => out.push(s),
      err: (/** @type {string} */ s) => err.push(s),
    },
  }
  return { options, out, err, paths, uhr: () => clock }
}

test('runDeployCheck: alle Pflicht-Checks grün → 0 und eine Zeile auf stdout', async () => {
  const u = umgebung({
    checks: [required('quality'), required('tests')],
    checkRuns: [run('quality', 'completed', 'success'), run('tests', 'completed', 'success')],
  })
  assert.equal(await runDeployCheck(u.options), 0)
  assert.equal(u.out.join(''), `deploy-check: grün ${SHA} quality,tests\n`)
})

test('runDeployCheck: rot, laufend oder fehlend → 1', async () => {
  for (const checkRuns of [
    [run('quality', 'completed', 'failure')],
    [run('quality', 'queued', null)],
    [],
  ]) {
    const u = umgebung({ checkRuns })
    assert.equal(await runDeployCheck(u.options), 1)
    assert.match(u.err.join(''), /quality/)
    assert.match(u.out.join(''), /^deploy-check: blockiert /)
  }
})

// Ein Repo ohne Pflicht-Checks hat nichts, wofür ein Grün einstehen könnte.
test('runDeployCheck: keine Pflicht-Checks → 2, nicht grün', async () => {
  const u = umgebung({ checks: [] })
  assert.equal(await runDeployCheck(u.options), 2)
  assert.match(u.err.join(''), /keine Pflicht-Checks/i)
})

test('runDeployCheck: API-Fehler → 2', async () => {
  const u = umgebung({ apiFails: true })
  assert.equal(await runDeployCheck(u.options), 2)
  assert.match(u.err.join(''), /Bad credentials/)
})

test('runDeployCheck: Override mit Begründung → 0, das Urteil bleibt sichtbar', async () => {
  const u = umgebung({
    checkRuns: [run('quality', 'completed', 'failure')],
    env: { QUALITY_DEPLOY_OVERRIDE: 'Hotfix Login, CI-Runner down' },
  })
  assert.equal(await runDeployCheck(u.options), 0)
  assert.equal(u.out.join(''), `deploy-check: override ${SHA} — Hotfix Login, CI-Runner down\n`)
  assert.match(u.err.join(''), /rot/)
  assert.match(u.err.join(''), /Hotfix Login/)
})

test('runDeployCheck: Override greift auch, wenn keine Aussage möglich ist', async () => {
  const u = umgebung({ apiFails: true, env: { QUALITY_DEPLOY_OVERRIDE: 'GitHub down' } })
  assert.equal(await runDeployCheck(u.options), 0)
  assert.match(u.out.join(''), /^deploy-check: override /)
})

test('runDeployCheck: leerer Override zählt nicht', async () => {
  for (const value of ['', '   ']) {
    const u = umgebung({
      checkRuns: [run('quality', 'completed', 'failure')],
      env: { QUALITY_DEPLOY_OVERRIDE: value },
    })
    assert.equal(await runDeployCheck(u.options), 1)
  }
})

test('runDeployCheck: --wait fragt nach, bis der Lauf fertig ist', async () => {
  let abfragen = 0
  const u = umgebung({
    waitSeconds: 600,
    checkRuns: () => {
      abfragen++
      return abfragen < 3
        ? [run('quality', 'in_progress', null)]
        : [run('quality', 'completed', 'success')]
    },
  })
  assert.equal(await runDeployCheck(u.options), 0)
  assert.equal(abfragen, 3)
  assert.equal(u.uhr(), 30_000)
})

test('runDeployCheck: --wait endet sofort bei rot', async () => {
  const u = umgebung({ waitSeconds: 600, checkRuns: [run('quality', 'completed', 'failure')] })
  assert.equal(await runDeployCheck(u.options), 1)
  assert.equal(u.uhr(), 0)
})

test('runDeployCheck: --wait gibt nach der Frist auf', async () => {
  const u = umgebung({ waitSeconds: 40, checkRuns: [run('quality', 'queued', null)] })
  assert.equal(await runDeployCheck(u.options), 1)
  assert.ok(u.uhr() <= 40_000, `gewartet: ${u.uhr()} ms`)
})

test('runDeployCheck: unbekannter Ref → 2', async () => {
  const u = umgebung()
  u.options.git = () => {
    throw new Error('fatal: Needed a single revision')
  }
  assert.equal(await runDeployCheck(u.options), 2)
  assert.match(u.err.join(''), /HEAD/)
})

test('runDeployCheck: origin ausserhalb von GitHub → 2', async () => {
  const u = umgebung()
  u.options.git = (/** @type {string[]} */ args) =>
    args[0] === 'rev-parse' ? SHA : 'https://gitlab.com/o/r.git'
  assert.equal(await runDeployCheck(u.options), 2)
  assert.match(u.err.join(''), /GitHub/)
})

// Gemessen am 14.10.2026: Für eine SHA, die GitHub nicht kennt, antwortet die
// API mit HTTP 422. Das ist eine klare Aussage — der Commit ist nicht gepusht —
// und keine Störung. Darum 1 und nicht 2.
test('runDeployCheck: nicht gepushter Commit → 1 mit Hinweis auf den Push', async () => {
  const u = umgebung({ unbekannterCommit: true })
  assert.equal(await runDeployCheck(u.options), 1)
  assert.match(u.err.join(''), /fehlt/)
  assert.match(u.err.join(''), /gepusht/)
})

// Review-Befund: Ein Re-Run in der Warteschlange hat noch kein started_at.
// Er ist trotzdem der jüngste Lauf und darf nicht hinter einem alten grünen
// verschwinden.
test('evaluate: ein Re-Run ohne started_at gilt als jüngster Lauf', () => {
  const runs = [
    run('quality', 'completed', 'success', '2026-10-14T10:00:00Z'),
    { ...run('quality', 'queued', null), started_at: null },
  ]
  assert.equal(evaluate([required('quality')], runs, [])[0]?.verdict, 'läuft')
})

test('requiredChecks: Protection und Rulesets zählen beide, doppelte einmal', () => {
  const protection = {
    required_status_checks: { checks: [{ context: 'quality', app_id: ACTIONS }] },
  }
  const rules = [
    { type: 'deletion' },
    {
      type: 'required_status_checks',
      parameters: {
        required_status_checks: [
          { context: 'quality', integration_id: ACTIONS },
          { context: 'tests' },
        ],
      },
    },
  ]
  assert.deepEqual(requiredChecks(protection, rules), [
    { context: 'quality', app_id: ACTIONS },
    { context: 'tests', app_id: null },
  ])
})

test('requiredChecks: ältere Protection mit nur contexts', () => {
  assert.deepEqual(requiredChecks({ required_status_checks: { contexts: ['quality'] } }, []), [
    { context: 'quality', app_id: null },
  ])
  assert.deepEqual(requiredChecks(undefined, []), [])
})

// Review-Befund: Eine Frist unter dem Abfragetakt wartete gar nicht.
test('runDeployCheck: --wait unter 15 s fragt nach Ablauf der Frist noch einmal', async () => {
  let abfragen = 0
  const u = umgebung({
    waitSeconds: 10,
    checkRuns: () => {
      abfragen++
      return abfragen < 2
        ? [run('quality', 'in_progress', null)]
        : [run('quality', 'completed', 'success')]
    },
  })
  assert.equal(await runDeployCheck(u.options), 0)
  assert.equal(u.uhr(), 10_000)
})

test('runDeployCheck: sind alle Checks an eine App gebunden, fragt es keine Statuses ab', async () => {
  const u = umgebung({ checkRuns: [run('quality', 'completed', 'success')] })
  assert.equal(await runDeployCheck(u.options), 0)
  assert.ok(!u.paths.some((p) => p.includes('/statuses')), u.paths.join('\n'))
})

test('runDeployCheck: HTTP 422 ohne den bekannten Wortlaut zählt ebenfalls als nicht gepusht', async () => {
  const u = umgebung()
  const api = u.options.api
  u.options.api = (/** @type {string} */ path) => {
    if (path.includes('/check-runs')) throw new Error(`gh api ${path}: Unprocessable (HTTP 422)`)
    return api(path)
  }
  assert.equal(await runDeployCheck(u.options), 1)
})
