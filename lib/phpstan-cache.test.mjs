import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { healStaleCache, stalePath } from './phpstan-cache.mjs'

// Die Meldungen stammen aus adboard, 12.11.2026, PHPStan 2.3.4. Der Worktree
// war gelöscht, der gemeinsame Cache in $TMPDIR/phpstan verwies noch darauf.
const GONE = '/nirgends/adboard-worktrees/geloescht/backend/vendor/phpstan/phpstan/phpstan.phar'
const STUB = `phar://${GONE}/vendor/ondrejmirtes/better-reflection/src/SourceLocator/SourceStubber/../../../../../jetbrains/phpstorm-stubs/standard/standard_10.stub`

/** PHPStans JSON: die Meldung steht in `errors`. */
const json = `{"totals":{"errors":1,"file_errors":0},"files":{},"errors":[${JSON.stringify(
  `Internal error: "${STUB}" is not a file while analysing file /p/app/A.php`,
)}]}`

/** PHPStans Tabelle: der Pfad ist auf 75 Zeichen umbrochen. */
function table() {
  const text = `"${STUB}" is not a file while analysing file /p/app/A.php`
  const lines = ['     Internal error:']
  for (let i = 0; i < text.length; i += 73) lines.push(`     ${text.slice(i, i + 73)}  `)
  return [' -- ---', '     Error', ' -- ---', ...lines, ' -- ---'].join('\n')
}

/** Kurzformat von laravel/pao: dieselbe Meldung, JSON-maskiert. */
const pao = `{"tool":"phpstan","result":"failed","errors":1,"general_errors":[${JSON.stringify(
  `Internal error: "${STUB}" is not a file while analysing file /p/app/A.php`,
)}]}`

test('stalePath erkennt den verwaisten Pfad im JSON-Bericht', () => {
  assert.equal(stalePath(json), GONE)
})

test('stalePath erkennt den verwaisten Pfad in der umbrochenen Tabelle', () => {
  assert.equal(stalePath(table()), GONE)
})

test('stalePath erkennt den verwaisten Pfad im Kurzformat von laravel/pao', () => {
  assert.equal(stalePath(pao), GONE)
})

test('stalePath übergeht die Meldung, wenn die Datei noch existiert', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-stale-'))
  try {
    const phar = join(dir, 'phpstan.phar')
    writeFileSync(phar, '')
    const output = `Internal error: "phar://${phar}/x.stub" is not a file while analysing file /p/A.php`
    assert.equal(stalePath(output), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('stalePath übergeht gewöhnliche Befunde', () => {
  assert.equal(stalePath('Line 3: Function f() should return int but returns string.'), null)
})

test('healStaleCache löscht den Reflection-Cache bei verwaistem Pfad', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-cache-'))
  try {
    const cache = join(dir, 'PHPStan')
    mkdirSync(join(cache, '61', 'ad'), { recursive: true })
    writeFileSync(join(cache, '61', 'ad', 'x.dat'), 'alt')
    assert.equal(healStaleCache(json, { dir: cache }), true)
    assert.equal(existsSync(cache), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('healStaleCache lässt den Cache bei anderen Fehlern stehen', () => {
  const dir = mkdtempSync(join(tmpdir(), 'quality-cache-'))
  try {
    const cache = join(dir, 'PHPStan')
    mkdirSync(cache)
    assert.equal(
      healStaleCache('Internal error: Allowed memory size exhausted', { dir: cache }),
      false,
    )
    assert.equal(existsSync(cache), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
