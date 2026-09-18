import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { baselineTargets, pruneBaselineFile } from './baseline-run.mjs'

const BASELINE = [
  'parameters:',
  '\tignoreErrors:',
  '\t\t-',
  "\t\t\tmessage: '#^Lebt\\.$#'",
  '\t\t\tidentifier: property.notFound',
  '\t\t\tcount: 4',
  '\t\t\tpath: app/A.php',
  '',
  '\t\t-',
  "\t\t\tmessage: '#^Tot\\.$#'",
  '\t\t\tidentifier: property.notFound',
  '\t\t\tcount: 1',
  '\t\t\tpath: app/A.php',
  '',
].join('\n')

/** Ein Projekt mit einer Komponente, optional mit Baseline. */
function fixture({ stack = 'laravel', withBaseline = true, path = 'backend' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quality-prune-'))
  mkdirSync(join(root, path), { recursive: true })
  if (withBaseline) writeFileSync(join(root, path, 'phpstan-baseline.neon'), BASELINE)
  return { root, config: { root, components: [{ path, stack, phpstanLevel: 5 }] } }
}

/** Ein PHPStan-Bericht, der genau den zweiten Eintrag für tot erklärt. */
const reportDead = (dir) => ({
  totals: { errors: 0, file_errors: 1 },
  files: {
    [join(dir, 'app/A.php')]: {
      errors: 1,
      messages: [
        {
          message: `Ignored error pattern #^Tot\\.$# (property.notFound) in path ${join(dir, 'app/A.php')} was not matched in reported errors.`,
          line: null,
          ignorable: false,
          identifier: 'ignore.unmatched',
        },
      ],
    },
  },
  errors: [],
})

test('baselineTargets findet die Baseline einer PHP-Komponente', () => {
  const { root, config } = fixture()
  try {
    const targets = baselineTargets(config)
    assert.equal(targets.length, 1)
    assert.equal(targets[0].file, join(root, 'backend', 'phpstan-baseline.neon'))
    assert.equal(targets[0].dir, join(root, 'backend'))
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('baselineTargets übergeht eine Komponente ohne Baseline', () => {
  const { root, config } = fixture({ withBaseline: false })
  try {
    assert.deepEqual(baselineTargets(config), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('baselineTargets übergeht Komponenten ohne PHP', () => {
  const { root, config } = fixture({ stack: 'react-ts' })
  try {
    assert.deepEqual(baselineTargets(config), [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneBaselineFile entfernt einen toten Eintrag und schreibt die Datei', () => {
  const { root, config } = fixture()
  const target = baselineTargets(config)[0]
  try {
    const result = pruneBaselineFile(target, { analyse: () => reportDead(target.dir) })
    assert.equal(result.dropped, 1)
    assert.equal(result.lowered, 0)
    assert.equal(result.written, true)
    const text = readFileSync(target.file, 'utf8')
    assert.ok(!text.includes('Tot'), 'der tote Eintrag müsste weg sein')
    assert.ok(text.includes('Lebt'), 'der lebende Eintrag müsste bleiben')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneBaselineFile schreibt bei dryRun nicht', () => {
  const { root, config } = fixture()
  const target = baselineTargets(config)[0]
  try {
    const result = pruneBaselineFile(target, { analyse: () => reportDead(target.dir), dryRun: true })
    assert.equal(result.dropped, 1)
    assert.equal(result.written, false)
    assert.equal(readFileSync(target.file, 'utf8'), BASELINE)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneBaselineFile schreibt bei einer Sperre nicht', () => {
  // Ein abgebrochener Lauf würde lebende Einträge als tot ausweisen.
  const { root, config } = fixture()
  const target = baselineTargets(config)[0]
  try {
    const report = { ...reportDead(target.dir), errors: ['Internal error: segfault'] }
    const result = pruneBaselineFile(target, { analyse: () => report })
    assert.deepEqual(result.blockers, ['Internal error: segfault'])
    assert.equal(result.written, false)
    assert.equal(readFileSync(target.file, 'utf8'), BASELINE)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneBaselineFile schreibt nicht, wenn nichts zu tun ist', () => {
  const { root, config } = fixture()
  const target = baselineTargets(config)[0]
  try {
    const leer = { totals: { errors: 0, file_errors: 0 }, files: {}, errors: [] }
    const result = pruneBaselineFile(target, { analyse: () => leer })
    assert.equal(result.dropped, 0)
    assert.equal(result.written, false)
    assert.equal(readFileSync(target.file, 'utf8'), BASELINE)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneBaselineFile schreibt nicht, wenn der Analysator keinen Bericht liefert', () => {
  const { root, config } = fixture()
  const target = baselineTargets(config)[0]
  try {
    const result = pruneBaselineFile(target, { analyse: () => null })
    assert.equal(result.written, false)
    assert.ok(result.blockers.length > 0, 'ein fehlender Bericht ist eine Sperre')
    assert.equal(readFileSync(target.file, 'utf8'), BASELINE)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneBaselineFile senkt einen zu hohen Zähler', () => {
  const { root, config } = fixture()
  const target = baselineTargets(config)[0]
  const file = join(target.dir, 'app/A.php')
  try {
    const report = {
      totals: { errors: 0, file_errors: 1 },
      files: {
        [file]: {
          errors: 1,
          messages: [
            {
              message: `Ignored error pattern #^Lebt\\.$# (property.notFound) in path ${file} is expected to occur 4 times, but occurred only 1 time.`,
              line: 3,
              ignorable: false,
              identifier: 'ignore.count',
            },
          ],
        },
      },
      errors: [],
    }
    const result = pruneBaselineFile(target, { analyse: () => report })
    assert.equal(result.lowered, 1)
    assert.equal(result.dropped, 0)
    assert.match(readFileSync(target.file, 'utf8'), /^\t\t\tcount: 1$/m)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('pruneBaselineFile schreibt keine Zeile, die die Baseline nicht hatte', () => {
  // Die Zusicherung des Werkzeugs: es kann nur schrumpfen.
  const { root, config } = fixture()
  const target = baselineTargets(config)[0]
  try {
    pruneBaselineFile(target, { analyse: () => reportDead(target.dir) })
    const vorher = new Set(BASELINE.split('\n'))
    const neu = readFileSync(target.file, 'utf8')
      .split('\n')
      .filter((line) => !vorher.has(line))
    assert.deepEqual(neu, [])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
