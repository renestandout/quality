import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  BASELINE_TOLERANCE,
  countTscErrors,
  jsAuditCommand,
  parseComposerAudit,
  parseBaselineCounts,
  parseNpmAudit,
  parsePhpstanJson,
  parsePipAudit,
  recommendLevel,
  recommendPhpstanLevel,
  renderConfigYaml,
  scanHygiene,
  shortVersion,
} from './audit.mjs'

test('npm audit: Zählung je Schweregrad', () => {
  const counts = parseNpmAudit({
    metadata: { vulnerabilities: { info: 3, low: 1, moderate: 2, high: 4, critical: 0, total: 10 } },
  })
  assert.equal(counts.high, 4)
  assert.equal(counts.moderate, 2)
  // "info" zählt bewusst nicht mit: das ist keine Verwundbarkeit.
  assert.equal(counts.total, 7)
})

test('npm audit: fehlende Metadaten ergeben Nullen statt NaN', () => {
  assert.equal(parseNpmAudit({}).total, 0)
  assert.equal(parseNpmAudit(null).total, 0)
})

test('pnpm audit: dieselbe Form wie npm, derselbe Parser', () => {
  // Gemessen an resplan (pnpm 9.12): pnpm schreibt metadata.vulnerabilities
  // mit denselben Schlüsseln wie npm. Ein eigener Parser waere eine zweite
  // Wahrheit ueber dieselbe Zahl.
  const counts = parseNpmAudit({
    actions: [],
    advisories: {},
    muted: [],
    metadata: {
      vulnerabilities: { info: 0, low: 1, moderate: 18, high: 25, critical: 5 },
      totalDependencies: 794,
    },
  })
  assert.equal(counts.critical, 5)
  assert.equal(counts.high, 25)
  assert.equal(counts.total, 49)
})

test('Dependency-Audit: das Lockfile bestimmt das Werkzeug', () => {
  assert.deepEqual(jsAuditCommand(['package-lock.json']), { cmd: 'npm', args: ['audit', '--json'] })
  assert.deepEqual(jsAuditCommand(['npm-shrinkwrap.json']), { cmd: 'npm', args: ['audit', '--json'] })
  assert.deepEqual(jsAuditCommand(['pnpm-lock.yaml']), { cmd: 'pnpm', args: ['audit', '--json'] })
})

test('Dependency-Audit: npm gewinnt, wenn zwei Lockfiles nebeneinander liegen', () => {
  // Ein Zustand, den niemand absichtlich herstellt. Wichtiger als die Wahl
  // ist, dass sie feststeht und nicht von der Reihenfolge im Verzeichnis haengt.
  assert.equal(jsAuditCommand(['pnpm-lock.yaml', 'package-lock.json']).cmd, 'npm')
  assert.equal(jsAuditCommand(['package-lock.json', 'pnpm-lock.yaml']).cmd, 'npm')
})

test('Dependency-Audit: ein Lockfile an der Wurzel wird nicht verschwiegen', () => {
  // "kein Lockfile" waere hier schlicht falsch: es gibt eines, nur nicht in
  // der Komponente. Gemessen wird trotzdem nichts — npm und pnpm messen an
  // dieser Stelle den ganzen Workspace, nicht die Komponente.
  const plan = jsAuditCommand([], {
    componentPath: 'ads-cockpit/frontend',
    rootLockfiles: ['pnpm-lock.yaml'],
  })
  assert.equal(plan.cmd, undefined)
  assert.match(plan.hint, /ads-cockpit\/frontend/)
  assert.match(plan.hint, /pnpm-lock\.yaml/)
  assert.match(plan.hint, /Repo-Wurzel/)
})

test('Dependency-Audit: das Lockfile der Komponente schlaegt das der Wurzel', () => {
  // Der Wurzel-Hinweis greift nur, wenn vor Ort gar nichts entschieden hat.
  const plan = jsAuditCommand(['package-lock.json'], {
    componentPath: 'ads-cockpit/frontend',
    rootLockfiles: ['pnpm-lock.yaml'],
  })
  assert.deepEqual(plan, { cmd: 'npm', args: ['audit', '--json'] })
})

test('Dependency-Audit: yarn und "gar kein Lockfile" melden statt zu raten', () => {
  const yarn = jsAuditCommand(['yarn.lock'])
  assert.equal(yarn.cmd, undefined)
  assert.match(yarn.hint, /yarn/)
  assert.deepEqual(jsAuditCommand([]), { hint: 'kein Lockfile' })
  // Auch mit Kontext, aber ohne Lockfile irgendwo, bleibt der Satz schlicht.
  assert.deepEqual(jsAuditCommand([], { componentPath: 'app', rootLockfiles: [] }), {
    hint: 'kein Lockfile',
  })
})

test('composer audit: mehrere Advisories je Paket zählen einzeln', () => {
  const counts = parseComposerAudit({
    advisories: {
      'guzzlehttp/guzzle': [{ severity: 'high' }, { severity: 'medium' }],
      'league/commonmark': [{ severity: 'critical' }],
    },
  })
  assert.equal(counts.total, 3)
  assert.equal(counts.high, 1)
  assert.equal(counts.critical, 1)
  // composer sagt "medium", npm sagt "moderate" — im Bericht ist es dasselbe.
  assert.equal(counts.moderate, 1)
})

test('phpstan: allgemeine und dateibezogene Fehler zählen zusammen', () => {
  const parsed = parsePhpstanJson({
    totals: { errors: 1, file_errors: 4 },
    files: { '/repo/app/A.php': { errors: 3 }, '/repo/app/B.php': { errors: 1 } },
  })
  assert.equal(parsed.errors, 5)
  assert.equal(parsed.byFile[0].file, '/repo/app/A.php')
})

test('phpstan: das Agent-Format zählt aus "errors", nicht aus der gekappten Liste', () => {
  // PHPStan 2.2 antwortet in Agent-Umgebungen so und ignoriert --error-format.
  // error_details ist gekappt — wer die addiert, misst 3 statt 1024.
  const parsed = parsePhpstanJson({
    tool: 'phpstan',
    result: 'failed',
    errors: 1024,
    error_details: {
      '/repo/app/A.php': [{ line: 1 }, { line: 2 }],
      '/repo/app/B.php': [{ line: 9 }],
    },
  })
  assert.equal(parsed.errors, 1024)
  assert.equal(parsed.truncated, true)
  assert.equal(parsed.byFile[0].errors, 2)
})

test('phpstan: eine vollständige Agent-Antwort gilt nicht als gekappt', () => {
  const parsed = parsePhpstanJson({
    tool: 'phpstan',
    result: 'failed',
    errors: 3,
    error_details: { '/repo/app/A.php': [{ line: 1 }, { line: 2 }], '/repo/app/B.php': [{ line: 9 }] },
  })
  assert.equal(parsed.truncated, false)
})

test('Baseline: count-Angaben werden je Datei summiert', () => {
  const baseline = [
    'parameters:',
    '\tignoreErrors:',
    '\t\t-',
    '\t\t\tmessage: "#^Fehler A$#"',
    '\t\t\tcount: 3',
    '\t\t\tpath: app/Report.php',
    '\t\t-',
    '\t\t\tmessage: "#^Fehler B$#"',
    '\t\t\tpath: app/Report.php',
    '\t\t-',
    '\t\t\tmessage: "#^Fehler C$#"',
    '\t\t\tcount: 2',
    '\t\t\tpath: app/Other.php',
  ].join('\n')
  const counts = parseBaselineCounts(baseline)
  // Ohne count-Zeile zählt ein Eintrag einfach, sonst wäre die Summe zu klein.
  assert.deepEqual(counts, [
    { file: 'app/Report.php', errors: 4 },
    { file: 'app/Other.php', errors: 2 },
  ])
})

test('tsc: zählt Fehlerzeilen, nicht Zusammenfassungen', () => {
  const output = [
    'src/a.ts(3,9): error TS6133: unused',
    'src/b.ts(1,1): error TS2304: cannot find name',
    'Found 2 errors in 2 files.',
  ].join('\n')
  assert.equal(countTscErrors(output), 2)
  assert.equal(countTscErrors('kein Fehler'), 0)
})

test('Empfehlung: grünes Level braucht keine Baseline', () => {
  const rec = recommendPhpstanLevel([
    { level: 9, errors: 12 },
    { level: 6, errors: 0 },
    { level: 4, errors: 0 },
  ])
  assert.equal(rec.phpstanLevel, 6)
  assert.equal(rec.baseline, false)
})

test('Empfehlung: ohne grünes Level das höchste noch abtragbare', () => {
  // Die Messwerte von adboard vom 15.08.2026.
  const rec = recommendPhpstanLevel([
    { level: 0, errors: 2 },
    { level: 1, errors: 2 },
    { level: 4, errors: 352 },
    { level: 5, errors: 429 },
    { level: 9, errors: 1024 },
  ])
  assert.equal(rec.phpstanLevel, 5)
  assert.equal(rec.baseline, true)
  assert.match(rec.reason, /429/)
})

test('Empfehlung: eine unabtragbare Baseline wird nicht vorgeschlagen', () => {
  const rec = recommendPhpstanLevel([
    { level: 0, errors: BASELINE_TOLERANCE + 1 },
    { level: 5, errors: 9000 },
  ])
  assert.equal(rec.phpstanLevel, 0)
  assert.match(rec.reason, /Erst aufräumen/)
})

test('Empfehlung: ohne Messung wird das gesagt statt geraten', () => {
  const rec = recommendPhpstanLevel([])
  assert.equal(rec.measured, false)
  assert.match(rec.reason, /nicht gemessen/)
})

test('Regelschärfe: strict nur bei heute sauberem Linter und tsc', () => {
  assert.equal(recommendLevel([{ lint: { clean: true }, types: { clean: true } }]).level, 'strict')
  assert.equal(recommendLevel([{ lint: { clean: false }, types: { clean: true } }]).level, 'standard')
  assert.equal(recommendLevel([{ lint: { skipped: true } }]).level, 'standard')
  assert.equal(recommendLevel([]).level, 'standard')
})

test('quality.yml: Baseline gilt fürs Projekt, sobald eine Komponente sie braucht', () => {
  const yaml = renderConfigYaml({
    level: 'strict',
    components: [
      { path: 'backend', stack: 'laravel', php: '8.3', phpstanLevel: 5, baseline: true },
      { path: 'frontend', stack: 'react-ts', baseline: false },
    ],
  })
  assert.match(yaml, /^baseline: true$/m)
  assert.match(yaml, /php: "8\.3"/)
  assert.match(yaml, /phpstan_level: 5/)
  // Ohne PHP-Komponente steht kein phpstan_level in der Frontend-Komponente.
  assert.equal(yaml.match(/phpstan_level/g).length, 1)
})

test('quality.yml: eine geratene Zahl wird als solche kenntlich gemacht', () => {
  const yaml = renderConfigYaml({
    level: 'standard',
    components: [{ path: '.', stack: 'laravel', phpstanLevel: 5, baseline: true, note: 'ungemessen, siehe Bericht' }],
  })
  assert.match(yaml, /phpstan_level: 5\s+# ungemessen/)
})

test('Hygiene: Suppressions im Quellcode, stillgelegte Tests nur in Testdateien', () => {
  const result = scanHygiene([
    { path: 'app/A.php', content: '// @phpstan-ignore-next-line\n$x = 1;', isTest: false },
    { path: 'src/b.ts', content: '// @ts-ignore\nconst a = 1', isTest: false },
    { path: 'tests/AT.php', content: '$this->markTestSkipped("später");', isTest: true },
    // Produktivcode, der zufällig "skip" enthält, ist gewöhnlicher Code.
    { path: 'src/pager.ts', content: 'export function skip(n) { return n }', isTest: false },
  ])
  const ids = result.rules.map((r) => r.id)
  assert.ok(ids.includes('suppression.phpstan'))
  assert.ok(ids.includes('suppression.typescript'))
  assert.ok(ids.includes('test.skipped'))
  assert.equal(result.rules.length, 3)
})

test('Hygiene: TODO-Marker werden gezählt', () => {
  const result = scanHygiene([{ path: 'a.ts', content: '// TODO: aufräumen\n// FIXME\nconst a=1', isTest: false }])
  assert.equal(result.todos, 2)
})

test('Versionen werden auf die Zahl gekürzt', () => {
  assert.equal(shortVersion('^8.3'), '8.3')
  assert.equal(shortVersion('~13.8.0'), '13.8.0')
  assert.equal(shortVersion(undefined), null)
})

test('pip-audit: Funde werden gezaehlt, aber nicht eingestuft', () => {
  // Die PyPI Advisory Database nennt keinen Schweregrad. Sie zu raten waere
  // schlechter als sie offen zu lassen: der Bericht schlaegt bei "hoch" und
  // "kritisch" Alarm, und dieser Alarm waere dann erfunden.
  const counts = parsePipAudit({
    dependencies: [
      { name: 'requests', version: '2.19.1', vulns: [{ id: 'PYSEC-2018-28' }, { id: 'GHSA-x84v' }] },
      { name: 'urllib3', version: '2.5.0', vulns: [] },
      { name: 'jinja2', version: '3.1.2', vulns: [{ id: 'GHSA-h5c8' }] },
    ],
  })
  assert.equal(counts.total, 3)
  assert.equal(counts.unknown, 3)
  assert.equal(counts.critical + counts.high + counts.moderate + counts.low, 0)
})

test('pip-audit: ohne Funde bleibt die Zaehlung leer', () => {
  assert.equal(parsePipAudit({ dependencies: [{ name: 'requests', vulns: [] }] }).total, 0)
  assert.equal(parsePipAudit({}).total, 0)
  // Aeltere pip-audit-Fassungen geben die Liste direkt aus, ohne Umschlag.
  assert.equal(parsePipAudit([{ name: 'jinja2', vulns: [{ id: 'GHSA-h5c8' }] }]).total, 1)
})
