import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyPrune, parseBaseline, planPrune, readIgnoreFindings } from './baseline.mjs'

/**
 * Eine Baseline im Format, das "phpstan --generate-baseline" schreibt: Tabs,
 * eine Leerzeile ZWISCHEN den Eintraegen, am Dateiende genau ein Zeilenumbruch.
 * Nachgeprueft an den Baselines von calcup und adboard.
 */
const baseline = (...entries) => 'parameters:\n\tignoreErrors:\n' + entries.join('\n\n') + '\n'

const entry = (message, { identifier = null, count = 1, path = 'app/A.php' } = {}) =>
  [
    '\t\t-',
    `\t\t\tmessage: '${message}'`,
    ...(identifier ? [`\t\t\tidentifier: ${identifier}`] : []),
    `\t\t\tcount: ${count}`,
    `\t\t\tpath: ${path}`,
  ].join('\n')

test('parseBaseline liest Nachricht, Identifier, Zähler und Pfad', () => {
  const { entries } = parseBaseline(
    baseline(entry('#^Zugriff\\.$#', { identifier: 'property.notFound', count: 3, path: 'app/B.php' }))
  )
  assert.equal(entries.length, 1)
  assert.deepEqual(
    { ...entries[0], from: undefined, to: undefined, countLine: undefined, source: undefined },
    {
      message: '#^Zugriff\\.$#',
      identifier: 'property.notFound',
      count: 3,
      path: 'app/B.php',
      readable: true,
      from: undefined,
      to: undefined,
      countLine: undefined,
      source: undefined,
    }
  )
})

test('parseBaseline nimmt eine einfach quotierte Nachricht wörtlich', () => {
  // Neon kennt in einfachen Anführungszeichen keine Backslash-Escapes. Die
  // Nachricht muss deshalb Zeichen für Zeichen so ankommen, wie PHPStan sie meldet.
  const { entries } = parseBaseline(baseline(entry('#^Nicht \\:\\:\\$x\\.$#')))
  assert.equal(entries[0].message, '#^Nicht \\:\\:\\$x\\.$#')
})

test('parseBaseline löst einen __DIR__-Pfad zu einem relativen Pfad auf', () => {
  const text = baseline(
    ['\t\t-', "\t\t\tmessage: '#^A\\.$#'", '\t\t\tcount: 1', "\t\t\tpath: __DIR__ . '/app/C.php'"].join('\n')
  )
  assert.equal(parseBaseline(text).entries[0].path, 'app/C.php')
})

test('parseBaseline merkt sich den Zeilenbereich inklusive der Leerzeile danach', () => {
  const text = baseline(entry('#^A\\.$#'), entry('#^B\\.$#'))
  const { entries, lines } = parseBaseline(text)
  assert.equal(entries.length, 2)
  // Kopf: Zeile 0 und 1. Erster Eintrag ab Zeile 2, bis zur Leerzeile danach.
  assert.equal(entries[0].from, 2)
  assert.equal(lines[entries[0].from].trim(), '-')
  assert.equal(lines[entries[0].to], '')
  assert.equal(entries[1].from, entries[0].to + 1)
})

test('parseBaseline merkt die Zeile des Zählers', () => {
  const { entries, lines } = parseBaseline(baseline(entry('#^A\\.$#', { count: 7 })))
  assert.match(lines[entries[0].countLine], /^\t\t\tcount: 7$/)
})

test('parseBaseline markiert einen Eintrag ohne Nachricht als unlesbar', () => {
  const text = baseline(['\t\t-', '\t\t\tcount: 1', '\t\t\tpath: app/A.php'].join('\n'))
  assert.equal(parseBaseline(text).entries[0].readable, false)
})

test('parseBaseline findet in einer leeren Baseline keine Einträge', () => {
  assert.deepEqual(parseBaseline('parameters:\n\tignoreErrors:\n').entries, [])
})

// ── readIgnoreFindings ────────────────────────────────────────────────────────
// Die Meldungstexte stammen aus einem echten PHPStan-Lauf (2.x) gegen eine
// Baseline mit einem toten Eintrag, einem Eintrag ohne Identifier und einem zu
// hoch gesetzten Zähler. Sie sind Vorlage, nicht Nachbau.

const FILE = '/projekt/src/A.php'

const report = (...messages) => ({
  totals: { errors: 0, file_errors: messages.length },
  files: { [FILE]: { errors: messages.length, messages } },
  errors: [],
})

test('readIgnoreFindings erkennt einen toten Eintrag samt Datei', () => {
  const found = readIgnoreFindings(
    report({
      message: `Ignored error pattern #^Nicht mehr da\\.$# (property.notFound) in path ${FILE} was not matched in reported errors.`,
      line: null,
      ignorable: false,
      identifier: 'ignore.unmatched',
    })
  )
  assert.deepEqual(found.dead, [{ file: FILE, core: '#^Nicht mehr da\\.$# (property.notFound)' }])
  assert.deepEqual(found.overcounted, [])
})

test('readIgnoreFindings erkennt einen toten Eintrag ohne Identifier', () => {
  const found = readIgnoreFindings(
    report({
      message: `Ignored error pattern #^Ohne Identifier\\.$# in path ${FILE} was not matched in reported errors.`,
      line: null,
      ignorable: false,
      identifier: 'ignore.unmatched',
    })
  )
  assert.deepEqual(found.dead, [{ file: FILE, core: '#^Ohne Identifier\\.$#' }])
})

test('readIgnoreFindings liest den tatsächlichen Zähler, auch im Singular', () => {
  const found = readIgnoreFindings(
    report({
      message: `Ignored error pattern #^Zugriff\\.$# (property.notFound) in path ${FILE} is expected to occur 3 times, but occurred only 1 time.`,
      line: 2,
      ignorable: false,
      identifier: 'ignore.count',
    })
  )
  assert.deepEqual(found.overcounted, [
    { file: FILE, core: '#^Zugriff\\.$# (property.notFound)', actual: 1 },
  ])
  assert.deepEqual(found.dead, [])
})

test('readIgnoreFindings übergeht gewöhnliche Befunde', () => {
  const found = readIgnoreFindings(
    report({
      message: 'Access to an undefined property A::$x.',
      line: 2,
      ignorable: true,
      identifier: 'property.notFound',
    })
  )
  assert.deepEqual(found.dead, [])
  assert.deepEqual(found.overcounted, [])
})

test('readIgnoreFindings meldet nicht-dateibezogene Fehler als Sperre', () => {
  // Ein abgebrochener Lauf darf nie zum Schrumpfen führen: er würde lebende
  // Einträge als tot ausweisen.
  const found = readIgnoreFindings({ totals: { errors: 1, file_errors: 0 }, files: {}, errors: ['Internal error'] })
  assert.deepEqual(found.blockers, ['Internal error'])
})

test('readIgnoreFindings meldet ohne nicht-dateibezogene Fehler keine Sperre', () => {
  assert.deepEqual(readIgnoreFindings(report()).blockers, [])
})

// ── planPrune ─────────────────────────────────────────────────────────────────

const DIR = '/projekt'
const dead = (core, file = `${DIR}/app/A.php`) => ({ dead: [{ file, core }], overcounted: [], blockers: [] })
const over = (core, actual, file = `${DIR}/app/A.php`) => ({
  dead: [],
  overcounted: [{ file, core, actual }],
  blockers: [],
})

test('planPrune ordnet einen toten Eintrag über Muster, Identifier und Pfad zu', () => {
  const parsed = parseBaseline(baseline(entry('#^A\\.$#', { identifier: 'property.notFound' })))
  const plan = planPrune(parsed, dead('#^A\\.$# (property.notFound)'), { dir: DIR })
  assert.deepEqual(plan.drop, [0])
  assert.deepEqual(plan.lower, [])
  assert.deepEqual(plan.unclaimed, [])
})

test('planPrune ordnet einen Eintrag ohne Identifier zu', () => {
  const parsed = parseBaseline(baseline(entry('#^A\\.$#')))
  assert.deepEqual(planPrune(parsed, dead('#^A\\.$#'), { dir: DIR }).drop, [0])
})

test('planPrune trifft nur den Eintrag mit passendem Pfad', () => {
  const parsed = parseBaseline(
    baseline(entry('#^A\\.$#', { path: 'app/A.php' }), entry('#^A\\.$#', { path: 'app/B.php' }))
  )
  assert.deepEqual(planPrune(parsed, dead('#^A\\.$#', `${DIR}/app/B.php`), { dir: DIR }).drop, [1])
})

test('planPrune senkt den Zähler statt den Eintrag zu entfernen', () => {
  const parsed = parseBaseline(baseline(entry('#^A\\.$#', { count: 3 })))
  const plan = planPrune(parsed, over('#^A\\.$#', 1), { dir: DIR })
  assert.deepEqual(plan.drop, [])
  assert.deepEqual(plan.lower, [{ index: 0, count: 1 }])
})

test('planPrune hebt einen Zähler nie an', () => {
  const parsed = parseBaseline(baseline(entry('#^A\\.$#', { count: 2 })))
  const plan = planPrune(parsed, over('#^A\\.$#', 5), { dir: DIR })
  assert.deepEqual(plan.lower, [])
  assert.deepEqual(plan.drop, [])
})

test('planPrune meldet eine Meldung ohne passenden Eintrag als unclaimed', () => {
  // Eine Ausnahme kann auch direkt in der phpstan.neon stehen. Sie gehört
  // nicht zur Baseline und darf dort nichts entfernen.
  const parsed = parseBaseline(baseline(entry('#^A\\.$#')))
  const plan = planPrune(parsed, dead('#^Fremd\\.$#'), { dir: DIR })
  assert.deepEqual(plan.drop, [])
  assert.deepEqual(plan.unclaimed, [{ file: `${DIR}/app/A.php`, core: '#^Fremd\\.$#' }])
})

test('planPrune schlägt bei einer Sperre nichts vor', () => {
  const parsed = parseBaseline(baseline(entry('#^A\\.$#')))
  const findings = { ...dead('#^A\\.$#'), blockers: ['Internal error'] }
  const plan = planPrune(parsed, findings, { dir: DIR })
  assert.deepEqual(plan.drop, [])
  assert.deepEqual(plan.lower, [])
  assert.deepEqual(plan.blockers, ['Internal error'])
})

test('planPrune entfernt einen unlesbaren Eintrag nie', () => {
  const parsed = parseBaseline(baseline(['\t\t-', '\t\t\tcount: 1', '\t\t\tpath: app/A.php'].join('\n')))
  assert.deepEqual(planPrune(parsed, dead('#^A\\.$#'), { dir: DIR }).drop, [])
})

// ── applyPrune ────────────────────────────────────────────────────────────────

const HEAD = 'parameters:\n\tignoreErrors:\n'

test('applyPrune gibt den Text bei leerem Plan unverändert zurück', () => {
  const text = baseline(entry('#^A\\.$#'), entry('#^B\\.$#'))
  assert.equal(applyPrune(parseBaseline(text), { drop: [], lower: [] }), text)
})

test('applyPrune entfernt den Block eines Eintrags und lässt die übrigen wörtlich stehen', () => {
  const text = baseline(entry('#^A\\.$#'), entry('#^B\\.$#'), entry('#^C\\.$#'))
  const result = applyPrune(parseBaseline(text), { drop: [1], lower: [] })
  assert.equal(result, baseline(entry('#^A\\.$#'), entry('#^C\\.$#')))
})

test('applyPrune entfernt auch den letzten Eintrag ohne den Zeilenumbruch zu verlieren', () => {
  const text = baseline(entry('#^A\\.$#'), entry('#^B\\.$#'))
  assert.equal(applyPrune(parseBaseline(text), { drop: [1], lower: [] }), baseline(entry('#^A\\.$#')))
})

test('applyPrune behält den Kopf, wenn alle Einträge wegfallen', () => {
  // Ein leerer ignoreErrors-Schlüssel ist gültig — an PHPStan 2.x nachgeprüft.
  // Den Kopf zu ändern wäre eine hinzugefügte Zeile und damit kein Schrumpfen.
  const text = baseline(entry('#^A\\.$#'), entry('#^B\\.$#'))
  assert.equal(applyPrune(parseBaseline(text), { drop: [0, 1], lower: [] }), HEAD)
})

test('applyPrune senkt die Zähler-Zeile und behält deren Einrückung', () => {
  const text = baseline(entry('#^A\\.$#', { count: 7 }))
  assert.equal(applyPrune(parseBaseline(text), { drop: [], lower: [{ index: 0, count: 2 }] }), baseline(entry('#^A\\.$#', { count: 2 })))
})

test('applyPrune bringt keine Zeile ein, die das Original nicht hat', () => {
  // Die konstruktionsbedingte Eigenschaft des Werkzeugs: es kann nur schrumpfen.
  // Die Zähler sind bewusst verschieden: ein gesenkter Wert, der zufällig
  // schon im Original steht, würde die Zusicherung nicht prüfen.
  const text = baseline(
    entry('#^A\\.$#', { identifier: 'a.b', count: 4 }),
    entry('#^B\\.$#', { identifier: 'c.d', count: 3, path: 'app/B.php' })
  )
  const result = applyPrune(parseBaseline(text), { drop: [1], lower: [{ index: 0, count: 2 }] })
  const original = new Set(text.split('\n'))
  const added = result.split('\n').filter((line) => !original.has(line) && line.trim() !== '')
  // Einzige erlaubte Ausnahme: die gesenkte Zähler-Zeile.
  assert.deepEqual(added, ['\t\t\tcount: 2'])
})

// ── Mehrzeilige Nachrichten ───────────────────────────────────────────────────
// Neon kennt einen Block-String mit """ oder '''. PHPStan schreibt ihn, sobald
// die Meldung einen Zeilenumbruch enthält — im Bestand 25 von 125 Einträgen in
// MauticCustomObjects. Die Werte unten stammen aus einem echten PHPStan-Lauf
// gegen genau diese Form.

const MULTILINE = [
  'parameters:',
  '\tignoreErrors:',
  '\t\t-',
  '\t\t\tmessage: """',
  '\t\t\t\t#^Erste Zeile mit \\\\$dollar\\\\:',
  '\t\t\t\tzweite Zeile\\\\.$#',
  '\t\t\t"""',
  '\t\t\tidentifier: deprecated.class',
  '\t\t\tcount: 1',
  '\t\t\tpath: app/A.php',
  '',
].join('\n')

/** Das Muster, wie PHPStan es meldet: dedentet, mit \n verbunden, Escapes gelöst. */
const MULTILINE_CORE = '#^Erste Zeile mit \\$dollar\\:\nzweite Zeile\\.$# (deprecated.class)'

test('parseBaseline liest eine mehrzeilige Nachricht dedentet und mit Zeilenumbruch', () => {
  const { entries } = parseBaseline(MULTILINE)
  assert.equal(entries.length, 1)
  assert.equal(entries[0].message, '#^Erste Zeile mit \\$dollar\\:\nzweite Zeile\\.$#')
})

test('parseBaseline liest Identifier, Zähler und Pfad hinter einer mehrzeiligen Nachricht', () => {
  const { entries } = parseBaseline(MULTILINE)
  assert.equal(entries[0].identifier, 'deprecated.class')
  assert.equal(entries[0].count, 1)
  assert.equal(entries[0].path, 'app/A.php')
  assert.equal(entries[0].readable, true)
})

test('parseBaseline umfasst bei einer mehrzeiligen Nachricht den ganzen Block', () => {
  const { entries, lines } = parseBaseline(MULTILINE)
  assert.equal(entries[0].from, 2)
  assert.match(lines[entries[0].to], /path: app\/A\.php/)
})

test("parseBaseline nimmt einen '''-Block wörtlich", () => {
  const text = [
    'parameters:',
    '\tignoreErrors:',
    '\t\t-',
    "\t\t\tmessage: '''",
    '\t\t\t\t#^Kein \\\\n Escape\\\\.$#',
    "\t\t\t'''",
    '\t\t\tcount: 1',
    '\t\t\tpath: app/A.php',
    '',
  ].join('\n')
  assert.equal(parseBaseline(text).entries[0].message, '#^Kein \\\\n Escape\\\\.$#')
})

test('parseBaseline löst Escapes einer doppelt quotierten Nachricht in einem Durchgang', () => {
  // Ein maskierter Backslash vor einem n bleibt Backslash plus n. Eine Kette
  // aus Einzelersetzungen macht daraus fälschlich einen Zeilenumbruch.
  const text = [
    'parameters:',
    '\tignoreErrors:',
    '\t\t-',
    '\t\t\tmessage: "#^Pfad C\\\\\\\\neu und \\\\|oder\\\\.$#"',
    '\t\t\tcount: 1',
    '\t\t\tpath: app/A.php',
    '',
  ].join('\n')
  assert.equal(parseBaseline(text).entries[0].message, '#^Pfad C\\\\neu und \\|oder\\.$#')
})

test('planPrune trifft einen Eintrag mit mehrzeiliger Nachricht', () => {
  const parsed = parseBaseline(MULTILINE)
  const plan = planPrune(parsed, dead(MULTILINE_CORE), { dir: DIR })
  assert.deepEqual(plan.drop, [0])
  assert.deepEqual(plan.unclaimed, [])
})

test('applyPrune entfernt einen Eintrag mit mehrzeiliger Nachricht vollständig', () => {
  const parsed = parseBaseline(MULTILINE)
  const result = applyPrune(parsed, { drop: [0], lower: [] })
  assert.equal(result, 'parameters:\n\tignoreErrors:\n')
})
