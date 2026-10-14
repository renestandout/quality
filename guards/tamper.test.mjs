import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isNullRef, runTamper } from './tamper-git.mjs'
import {
  PROTECTED_PATHS,
  SOFT_LOCALLY,
  SOURCE_FILE,
  analyseDiff,
  composerLockOnlyRehashes,
  findException,
  lockfileOnlyBumpsOwnVersion,
  isTestFile,
  parseDiff,
} from './tamper.mjs'

/** @import { Finding } from './tamper.mjs' */

/**
 * Ein echtes Repository mit genau einem Commit — dem Stand nach dem ersten Push.
 *
 * @param {string} content
 */
function gitFixture(content) {
  const root = mkdtempSync(join(tmpdir(), 'quality-tamper-'))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'a.ts'), content)
  git('add', '.')
  git('commit', '--quiet', '-m', 'erster Commit')
  return root
}

const diff = (/** @type {string} */ body) => parseDiff(body.trimStart())

/**
 * @param {string} body
 * @param {Parameters<typeof analyseDiff>[1]} [options]
 */
function check(body, options) {
  return analyseDiff(diff(body), options)
}

const rules = (/** @type {Finding[]} */ findings) => findings.map((f) => f.rule)

test('parseDiff zählt Zeilennummern der neuen Datei korrekt', () => {
  const files = diff(`
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -10,3 +10,4 @@
 const a = 1
+const neu = 2
 const b = 3
`)
  assert.equal(files.length, 1)
  assert.equal(files[0]?.path, 'src/a.ts')
  assert.deepEqual(files[0]?.added, [{ line: 11, text: 'const neu = 2' }])
})

test('hinzugefügte TypeScript-Suppression wird gemeldet', () => {
  const findings = check(`
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,2 +1,3 @@
 const a = 1
+// @ts-ignore
 const b = 2
`)
  assert.deepEqual(rules(findings), ['suppression.typescript'])
  assert.equal(findings[0]?.line, 2)
})

test('entfernte Suppression ist kein Fund', () => {
  const findings = check(`
diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -1,3 +1,2 @@
 const a = 1
-// @ts-ignore
 const b = 2
`)
  assert.deepEqual(findings, [])
})

test('PHPStan-Suppression im PHP-Code wird gemeldet', () => {
  const findings = check(`
diff --git a/app/Service.php b/app/Service.php
--- a/app/Service.php
+++ b/app/Service.php
@@ -5,1 +5,2 @@
 <?php
+/** @phpstan-ignore-next-line */
`)
  assert.deepEqual(rules(findings), ['suppression.phpstan'])
})

test('übersprungener Test in einer Testdatei wird gemeldet', () => {
  const findings = check(`
diff --git a/tests/Feature/LoginTest.php b/tests/Feature/LoginTest.php
--- a/tests/Feature/LoginTest.php
+++ b/tests/Feature/LoginTest.php
@@ -8,1 +8,2 @@
 public function test_login(): void
+    $this->markTestSkipped('später');
`)
  assert.deepEqual(rules(findings), ['test.skipped'])
})

test('.only in einer Testdatei wird gemeldet', () => {
  const findings = check(`
diff --git a/src/app.test.ts b/src/app.test.ts
--- a/src/app.test.ts
+++ b/src/app.test.ts
@@ -1,1 +1,2 @@
 import { test } from 'vitest'
+test.only('nur dieser', () => {})
`)
  assert.deepEqual(rules(findings), ['test.focused'])
})

test('Testdateien werden über alle üblichen Endungen erkannt', () => {
  // .test.mjs fiel im ersten Anlauf durch das Raster — node --test nutzt genau
  // diese Endung, und der stillgelegte Test blieb dadurch unbemerkt.
  for (const path of [
    'lib/probe.test.mjs',
    'lib/probe.test.cjs',
    'src/a.test.ts',
    'src/a.spec.tsx',
    'tests/Feature/LoginTest.php',
    'app/tests/helper.js',
  ]) {
    const findings = check(`
diff --git a/${path} b/${path}
--- a/${path}
+++ b/${path}
@@ -1,1 +1,2 @@
 const x = 1
+test.skip('x', () => {})
`)
    assert.deepEqual(rules(findings), ['test.skipped'], `nicht als Testdatei erkannt: ${path}`)
  }
})

test('Wörter wie skip oder only im Produktivcode sind kein Fund', () => {
  const findings = check(`
diff --git a/src/pagination.ts b/src/pagination.ts
--- a/src/pagination.ts
+++ b/src/pagination.ts
@@ -1,1 +1,4 @@
 export const x = 1
+export function skip(n: number) { return n }
+const readOnly = items.only
+// wir überspringen (skip) hier bewusst die Validierung
`)
  assert.deepEqual(findings, [])
})

test('gelöschte Testdatei wird gemeldet', () => {
  const findings = check(`
diff --git a/tests/Unit/ScoreTest.php b/tests/Unit/ScoreTest.php
deleted file mode 100644
--- a/tests/Unit/ScoreTest.php
+++ /dev/null
`)
  assert.deepEqual(rules(findings), ['test.deleted'])
  assert.equal(findings[0]?.path, 'tests/Unit/ScoreTest.php')
})

test('gelöschte Nicht-Testdatei ist kein Fund', () => {
  const findings = check(`
diff --git a/src/alt.ts b/src/alt.ts
deleted file mode 100644
--- a/src/alt.ts
+++ /dev/null
`)
  assert.deepEqual(findings, [])
})

test('geänderte Baseline wird gemeldet', () => {
  const findings = check(`
diff --git a/phpstan-baseline.neon b/phpstan-baseline.neon
--- a/phpstan-baseline.neon
+++ b/phpstan-baseline.neon
@@ -1,1 +1,2 @@
 parameters:
+    ignoreErrors: []
`)
  assert.deepEqual(rules(findings), ['protected.changed'])
})

test('geänderter CI-Workflow wird gemeldet', () => {
  const findings = check(`
diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml
--- a/.github/workflows/ci.yml
+++ b/.github/workflows/ci.yml
@@ -1,1 +1,2 @@
 name: CI
+# harmlos?
`)
  assert.deepEqual(rules(findings), ['protected.changed'])
})

test('ein Workflow namens quality.yml gilt als Workflow, nicht als Konfiguration', () => {
  const findings = check(`
diff --git a/.github/workflows/quality.yml b/.github/workflows/quality.yml
--- a/.github/workflows/quality.yml
+++ b/.github/workflows/quality.yml
@@ -1,1 +1,2 @@
 name: Quality
+# geändert
`)
  assert.deepEqual(rules(findings), ['protected.changed'])
  assert.equal(findings[0]?.label, 'CI-Workflow geändert')
})

test('quality.yml zählt nur in der Repo-Wurzel', () => {
  const wurzel = check(`
diff --git a/quality.yml b/quality.yml
--- a/quality.yml
+++ b/quality.yml
@@ -1,1 +1,2 @@
 version: 1
+level: standard
`)
  assert.equal(wurzel[0]?.label, 'Quality-Konfiguration geändert')

  // Eine gleichnamige Datei tief im Baum ist Projektinhalt, keine Gate-Konfiguration.
  const tiefer = check(`
diff --git a/docs/beispiele/quality.yml b/docs/beispiele/quality.yml
--- a/docs/beispiele/quality.yml
+++ b/docs/beispiele/quality.yml
@@ -1,1 +1,2 @@
 version: 1
+level: standard
`)
  assert.deepEqual(tiefer, [])
})

test('Lockfile-Änderung meldet, für Bots aber nicht', () => {
  const body = `
diff --git a/composer.lock b/composer.lock
--- a/composer.lock
+++ b/composer.lock
@@ -1,1 +1,2 @@
 {
+  "neu": true
`
  assert.deepEqual(rules(check(body)), ['dependency.changed'])
  assert.deepEqual(check(body, { botAuthor: true }), [])
})

test('ignorePaths schliesst Pfade aus', () => {
  const body = `
diff --git a/guards/tamper.mjs b/guards/tamper.mjs
--- a/guards/tamper.mjs
+++ b/guards/tamper.mjs
@@ -1,1 +1,2 @@
 const a = 1
+// @ts-ignore
`
  assert.equal(check(body).length, 1)
  assert.deepEqual(check(body, { ignorePaths: ['guards/'] }), [])
})

test('mehrere Funde in einer Datei werden einzeln gemeldet', () => {
  const findings = check(`
diff --git a/src/a.test.ts b/src/a.test.ts
--- a/src/a.test.ts
+++ b/src/a.test.ts
@@ -1,1 +1,4 @@
 import { test } from 'vitest'
+// @ts-ignore
+test.skip('a', () => {})
+test.only('b', () => {})
`)
  assert.deepEqual(rules(findings).sort(), [
    'suppression.typescript',
    'test.focused',
    'test.skipped',
  ])
})

test('findException erkennt den Trailer', () => {
  assert.equal(
    findException(['feat: x\n\nQuality-Exception: Test hängt an externer API']),
    'Test hängt an externer API',
  )
  assert.equal(
    findException(['feat: x\n\nquality-exception: kleingeschrieben']),
    'kleingeschrieben',
  )
  assert.equal(findException(['feat: ohne Trailer']), null)
  // Ein Trailer ohne Begründung zählt nicht.
  assert.equal(findException(['feat: x\n\nQuality-Exception:']), null)
})

test('leerer Diff ergibt keine Funde', () => {
  assert.deepEqual(check(''), [])
})

test('Suppression in einer Nicht-Quelldatei wird ignoriert', () => {
  const findings = check(`
diff --git a/README.md b/README.md
--- a/README.md
+++ b/README.md
@@ -1,1 +1,2 @@
 # Doku
+Beispiel: mit @ts-ignore lässt sich das abschalten.
`)
  assert.deepEqual(findings, [])
})

test('die lokal weichen Regeln entsprechen tatsächlich erzeugten Regel-IDs', () => {
  // Schützt davor, dass eine Regel umbenannt wird und die Ausnahme still
  // ins Leere greift — dann würde lokal blockiert, was blockieren soll,
  // oder schlimmer: es würde nichts mehr blockieren.
  const erzeugt = new Set()
  const proben = [
    `
diff --git a/quality.yml b/quality.yml
--- a/quality.yml
+++ b/quality.yml
@@ -1,1 +1,2 @@
 version: 1
+level: strict
`,
    `
diff --git a/composer.lock b/composer.lock
--- a/composer.lock
+++ b/composer.lock
@@ -1,1 +1,2 @@
 {
+  "x": 1
`,
    `
diff --git a/.prettierignore b/.prettierignore
--- a/.prettierignore
+++ b/.prettierignore
@@ -1,1 +1,2 @@
 /dist
+/src/legacy
`,
    `
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -1,1 +1,2 @@
 [allowlist]
+paths = ['''docs/''']
`,
  ]
  for (const p of proben) for (const f of check(p)) erzeugt.add(f.rule)
  for (const rule of SOFT_LOCALLY) {
    assert.ok(erzeugt.has(rule), `Regel "${rule}" wird von analyseDiff nicht mehr erzeugt`)
  }
})

test('Fremdcode wird nie bewertet, auch wenn er mitcommittet ist', () => {
  // Gewachsene CMS-Projekte committen vendor/ regelmässig mit. Ein
  // @ts-ignore darin stammt nicht vom Entwickler dieses Projekts.
  const findings = analyseDiff([
    {
      path: 'vendor/fremd/paket/src/A.php',
      added: [{ line: 1, text: '// @phpstan-ignore-next-line' }],
      deleted: false,
    },
    {
      path: 'node_modules/foo/index.js',
      added: [{ line: 1, text: '// eslint-disable' }],
      deleted: false,
    },
    { path: 'tests/vendor/MeinTest.php', deleted: true, added: [] },
  ])
  assert.deepEqual(findings, [])
})

test('Linter-Konfiguration ist auch als .mjs/.cjs geschützt', () => {
  // Regressionstest zu einer Lücke vom 16.08.2026: die Muster endeten auf
  // [jt]s und trafen damit weder .mjs noch .cjs. Ausgerechnet Projekte ohne
  // "type": "module" im package.json MÜSSEN .mjs verwenden — dort war die
  // Linterkonfiguration also unbemerkt ungeschützt, während pint.json und
  // phpstan.neon nebenan geschützt waren. Gefunden in rankscan/website.
  for (const datei of [
    'eslint.config.js',
    'eslint.config.ts',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.mts',
    'eslint.config.cts',
    'prettier.config.js',
    'prettier.config.mjs',
    'prettier.config.cjs',
    'prettier.config.mts',
  ]) {
    const findings = analyseDiff([
      { path: datei, added: [{ line: 1, text: '// gelockert' }], deleted: false },
    ])
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['protected.changed'],
      `${datei} müsste geschützt sein, ist es aber nicht`,
    )
  }
})

test('eine gleichnamige Quelldatei ist keine Konfiguration', () => {
  // Die Erweiterung um [cm]? darf nicht dazu führen, dass alles mit ähnlichem
  // Namen als Konfiguration gilt.
  for (const datei of [
    'src/eslint.config.helper.mjs',
    'eslint.configuration.mjs',
    'my-eslint.config.mjsx',
  ]) {
    const findings = analyseDiff([
      { path: datei, added: [{ line: 1, text: 'const a = 1' }], deleted: false },
    ])
    assert.deepEqual(findings, [], `${datei} darf nicht als geschützte Konfiguration gelten`)
  }
})

test('ein Bot darf Action-Versionen im Workflow anheben', () => {
  // Dependabot hebt `uses: actions/checkout@v4` auf `@v7` an — und trifft
  // damit einen geschützten Pfad. Ohne Ausnahme wäre JEDER Actions-PR rot,
  // auch ein reiner Patch-Bump. Gefunden am 16.08.2026 in rankscan/website,
  // wo genau das den PR blockierte.
  const diff = [
    {
      path: '.github/workflows/quality.yml',
      added: [{ line: 12, text: '      - uses: actions/checkout@v7' }],
      deleted: false,
    },
  ]
  assert.deepEqual(analyseDiff(diff, { botAuthor: true }), [], 'Bot-PR müsste durchgehen')
  assert.deepEqual(
    analyseDiff(diff, { botAuthor: false }).map((f) => f.rule),
    ['protected.changed'],
    'derselbe Diff von Hand müsste weiterhin melden',
  )
})

test('die Bot-Ausnahme gilt nicht für Suppressions und stillgelegte Tests', () => {
  // Der Schutz vor Gate-Umgehung darf nicht daran hängen, wer den Commit
  // signiert hat. Nur die maschinellen Versionsbumps sind gemeint.
  const findings = analyseDiff(
    [
      { path: 'src/A.ts', added: [{ line: 3, text: '// @ts-ignore' }], deleted: false },
      {
        path: 'tests/AT.php',
        added: [{ line: 9, text: '$this->markTestSkipped();' }],
        deleted: false,
      },
      { path: 'tests/Weg.php', deleted: true, added: [] },
    ],
    { botAuthor: true },
  )
  assert.deepEqual(
    findings.map((f) => f.rule).sort(),
    ['suppression.typescript', 'test.deleted', 'test.skipped'].sort(),
  )
})

test('hinzugefügte Ignore-Zeile in .prettierignore wird gemeldet', () => {
  const findings = check(`
diff --git a/.prettierignore b/.prettierignore
--- a/.prettierignore
+++ b/.prettierignore
@@ -1,2 +1,3 @@
 /dist
+/src/legacy
 /coverage
`)
  assert.deepEqual(rules(findings), ['ignore.extended'])
  assert.equal(findings[0]?.line, 2)
})

test('eine Negation in einer Ignore-Datei nimmt Code AUF und ist kein Fund', () => {
  // `!/vite.config.ts` neben einer Positivliste erweitert die Prüfung — das ist
  // das Gegenteil einer Umgehung.
  const findings = check(`
diff --git a/.prettierignore b/.prettierignore
--- a/.prettierignore
+++ b/.prettierignore
@@ -1,2 +1,4 @@
 /*
 !/resources
+!/vite.config.ts
+# die Wurzelkonfigurationen gehören ins Gate
`)
  assert.deepEqual(rules(findings), [])
})

test('Ignore-Regeln greifen auch für .eslintignore', () => {
  const findings = check(`
diff --git a/frontend/.eslintignore b/frontend/.eslintignore
--- a/frontend/.eslintignore
+++ b/frontend/.eslintignore
@@ -1 +1,2 @@
 build
+src/generated
`)
  assert.deepEqual(rules(findings), ['ignore.extended'])
})

test('die Ignore-Regel ist lokal weich und in CI bindend', () => {
  // Onboarding legt diese Dateien an; lokal gibt es noch keinen Commit und
  // damit keinen Trailer, mit dem sich das durchwinken liesse.
  assert.ok(SOFT_LOCALLY.has('ignore.extended'))
})

test('Ignore-Dateien stehen NICHT unter den geschützten Pfaden', () => {
  // Dieselbe Liste ist die Blockliste des PreToolUse-Hooks. Eine Positivliste
  // wie die von rankscan/application wird legitim erweitert; ein Hook, der das
  // blockt, hält die Arbeit auf.
  const findings = check(`
diff --git a/.prettierignore b/.prettierignore
--- a/.prettierignore
+++ b/.prettierignore
@@ -1 +1,2 @@
 /dist
+/src/legacy
`)
  assert.ok(!rules(findings).includes('protected.changed'))
})

test('parseDiff sammelt entfernte Zeilen, ohne die Kopfzeile mitzuzählen', () => {
  // "--- a/pfad" beginnt mit einem Minus und ist keine entfernte Zeile.
  const files = diff(`
diff --git a/tests/a.test.mjs b/tests/a.test.mjs
--- a/tests/a.test.mjs
+++ b/tests/a.test.mjs
@@ -1,3 +1,2 @@
 const x = 1
-assert.equal(x, 1)
 const y = 2
`)
  assert.deepEqual(
    files[0]?.removed?.map((r) => r.text),
    ['assert.equal(x, 1)'],
  )
})

test('netto entfernte Assertions in einer bleibenden Testdatei werden gemeldet', () => {
  // Die Umgehung, die dieser Regel zugrunde liegt: einen roten Test grün
  // machen, indem man entfernt, was er prüft.
  const findings = check(`
diff --git a/tests/Feature/PaymentTest.php b/tests/Feature/PaymentTest.php
--- a/tests/Feature/PaymentTest.php
+++ b/tests/Feature/PaymentTest.php
@@ -10,5 +10,3 @@
         $response = $this->post('/pay');
-        $response->assertStatus(200);
-        $this->assertDatabaseHas('payments', ['amount' => 100]);
     }
`)
  assert.deepEqual(rules(findings), ['test.assertions-removed'])
  // Die Zeile mit rules() verlangt genau einen Fund. findings[0] ist also gesetzt.
  assert.match(/** @type {Finding} */ (findings[0]).detail, /2/)
})

test('umgeschriebene Assertions sind kein Fund', () => {
  // Gleich viele raus wie rein: eine Umformulierung, keine Entfernung.
  const findings = check(`
diff --git a/tests/Feature/PaymentTest.php b/tests/Feature/PaymentTest.php
--- a/tests/Feature/PaymentTest.php
+++ b/tests/Feature/PaymentTest.php
@@ -10,4 +10,4 @@
-        $response->assertStatus(200);
+        $response->assertOk();
`)
  assert.deepEqual(rules(findings), [])
})

test('mehr Assertions als vorher ist kein Fund', () => {
  const findings = check(`
diff --git a/tests/a.test.mjs b/tests/a.test.mjs
--- a/tests/a.test.mjs
+++ b/tests/a.test.mjs
@@ -1,2 +1,3 @@
-assert.equal(a, 1)
+assert.equal(a, 1)
+expect(b).toBe(2)
`)
  assert.deepEqual(rules(findings), [])
})

test('entfernte Assertions im Produktivcode sind kein Fund', () => {
  // Ein assert() in einer Bibliothek ist gewöhnlicher Code.
  const findings = check(`
diff --git a/src/guard.ts b/src/guard.ts
--- a/src/guard.ts
+++ b/src/guard.ts
@@ -1,2 +1,1 @@
-assert(value !== null)
 return value
`)
  assert.deepEqual(rules(findings), [])
})

test('eine gelöschte Testdatei meldet nur die Löschung', () => {
  // Sonst stünde derselbe Vorgang zweimal im Bericht.
  const findings = check(`
diff --git a/tests/a.test.mjs b/tests/a.test.mjs
deleted file mode 100644
--- a/tests/a.test.mjs
+++ /dev/null
@@ -1,2 +0,0 @@
-assert.equal(a, 1)
-assert.equal(b, 2)
`)
  assert.deepEqual(rules(findings), ['test.deleted'])
})

test('hinzugefügte Allowlist-Zeile in .gitleaks.toml wird gemeldet', () => {
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -20,3 +20,4 @@
 [allowlist]
 regexes = [
+  '''SORT_STORAGE_KEY''',
 ]
`)
  assert.deepEqual(rules(findings), ['allowlist.extended'])
  assert.equal(findings[0]?.line, 22)
  assert.equal(findings[0]?.label, 'erweiterte Secret-Ausnahme')
})

test('die Form [[allowlists]] mit paths wird ebenso gemeldet', () => {
  // adboard und die drei rankscan-Repos schreiben es so, resplan als [allowlist].
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -12,0 +13,3 @@
+[[allowlists]]
+description = "docroot/ ist der Mautic-Upstream-Drop, kein Eigencode"
+paths = ['''^docroot/''']
`)
  assert.deepEqual(rules(findings), ['allowlist.extended'])
  // Gemeldet wird die Ausnahme selbst, nicht ihre Begründung.
  // Die Zeile mit rules() verlangt genau einen Fund. findings[0] ist also gesetzt.
  assert.match(/** @type {Finding} */ (findings[0]).detail, /\^docroot\//)
})

test('eine hinzugefügte [[rules]]-Sektion verschärft und ist kein Fund', () => {
  // Sonst meldete die Regel das Gegenteil von dem, was passiert.
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -5,0 +6,8 @@
+[[rules]]
+id = "moco-api-key"
+description = "MOCO-Schluessel (Praefix gk_)"
+regex = '''gk_[A-Za-z0-9_-]{16,}'''
+keywords = [
+  "gk_",
+]
+path = '''\\.env$'''
`)
  assert.deepEqual(findings, [])
})

test('eine unveränderte gitleaks-Konfiguration meldet nicht', () => {
  // Nur entfernte Zeilen: eine Ausnahme verschwindet, das verschärft.
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -20,3 +20,2 @@
 [allowlist]
-regexes = ['''alt''']
`)
  assert.deepEqual(findings, [])
})

test('gitleaks.toml ohne führenden Punkt zählt auch', () => {
  const findings = check(`
diff --git a/config/gitleaks.toml b/config/gitleaks.toml
--- a/config/gitleaks.toml
+++ b/config/gitleaks.toml
@@ -1,0 +2,2 @@
+[allowlist]
+stopwords = ["beispiel"]
`)
  assert.deepEqual(rules(findings), ['allowlist.extended'])
})

test('eine Allowlist INNERHALB einer Regel wird gemeldet', () => {
  // [rules.allowlist] nimmt Code aus genau dieser Regel — eine Ausnahme bleibt
  // eine Ausnahme, auch wenn sie unter [[rules]] steht.
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -10,0 +11,3 @@
+[[rules]]
+[rules.allowlist]
+paths = ['''tests/''']
`)
  assert.deepEqual(rules(findings), ['allowlist.extended'])
})

test('ein abgeschalteter Standard-Regelsatz wird gemeldet', () => {
  // useDefault = false steht in [extend] und ist die grösstmögliche Ausnahme.
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -3,1 +3,1 @@
 [extend]
-useDefault = true
+useDefault = false
`)
  assert.deepEqual(rules(findings), ['allowlist.extended'])
})

test('minVersion oder eine neue Regel allein melden nicht', () => {
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -1,0 +2,2 @@
+minVersion = "8.30.1"
+[extend]
`)
  assert.deepEqual(findings, [])
})

test('Realfall: resplans .gitleaks.toml erzeugt Treffer, aber nur aus der Allowlist', () => {
  // Die Datei kam am 20.08.2026 dazu (Branch task/audit-job, Commit 2b20fd3).
  // `quality tamper --base origin/main` meldete danach genau einen Treffer,
  // den CI-Workflow. Über die Allowlist sagte er nichts — der Anlass dieser Regel.
  const datei = `# Konfiguration fuer den Secret-Scan im audit-Job.
#
# Vier Fehlalarme machen einen Secret-Scan wertlos: man liest ihn nach dem
# zweiten Mal nicht mehr. Deshalb die Allowlist unten.

[extend]
useDefault = true

[[rules]]
id = "moco-api-key"
description = "MOCO-Schluessel (Praefix gk_)"
regex = '''gk_[A-Za-z0-9_-]{16,}'''
keywords = ["gk_"]

[allowlist]
description = "Geprueft am 20.08.2026 — vier Funde, kein Geheimnis darunter"
regexTarget = "line"
regexes = [
  # Namen von localStorage-Schluesseln.
  '''(SORT|COL_WIDTHS)_STORAGE_KEY''',
  # HMAC-Schluessel der MOCO-Webhook-Tests.
  '''1d608b9d72219b90ff2393a1d3ee0ac0''',
]
`
  const findings = analyseDiff([
    {
      path: '.gitleaks.toml',
      deleted: false,
      added: datei.split('\n').map((text, index) => ({ line: index + 1, text })),
    },
  ])

  assert.ok(findings.length > 0, 'die Datei müsste einen Treffer erzeugen')
  assert.deepEqual([...new Set(rules(findings))], ['allowlist.extended'])
  // Die eigene Regel auf das MOCO-Praefix verschärft und darf nicht auftauchen.
  for (const f of findings) {
    assert.doesNotMatch(f.detail, /gk_/, `verschärfende Zeile gemeldet: ${f.detail}`)
  }
  assert.ok(
    findings.some((f) => f.detail.includes('STORAGE_KEY')),
    'die weggedrückte Fundstelle müsste im Bericht stehen',
  )
})

test('die Allowlist-Regel ist lokal weich und in CI bindend', () => {
  // Wie bei den Ignore-Dateien: lokal gibt es keinen Commit und damit keinen
  // Trailer, mit dem sich das durchwinken liesse.
  assert.ok(SOFT_LOCALLY.has('allowlist.extended'))
})

test('die gitleaks-Konfiguration steht NICHT unter den geschützten Pfaden', () => {
  // Dieselbe Liste ist die Blockliste des PreToolUse-Hooks. Eine Konfiguration,
  // die legitim um eine [[rules]]-Sektion wächst, gehört nicht dorthin.
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -20,0 +21,1 @@
+paths = ['''docs/''']
`)
  assert.ok(!rules(findings).includes('protected.changed'))
})

test('die gitleaks-Baseline dagegen ist ein geschützter Pfad', () => {
  // Sie hält fest, welche Funde als bekannt gelten — dieselbe Rolle wie
  // phpstan-baseline.neon.
  for (const datei of [
    'gitleaks-baseline.json',
    '.gitleaks-baseline.json',
    'ci/gitleaks.baseline.json',
  ]) {
    const findings = analyseDiff([
      { path: datei, added: [{ line: 1, text: '[]' }], deleted: false },
    ])
    assert.deepEqual(rules(findings), ['protected.changed'], `${datei} müsste geschützt sein`)
    assert.equal(findings[0]?.label, 'gitleaks-Baseline geändert')
  }
})

test('eingrenzende Schlüssel in einer Allowlist sind kein Fund', () => {
  // targetRules bindet die Ausnahme an eine benannte Regel, condition = "AND"
  // verlangt alle Kriterien zugleich. Beides verengt sie.
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -29,0 +30,3 @@
+[[allowlists]]
+targetRules = ["generic-api-key"]
+condition = "AND"
`)
  assert.deepEqual(findings, [])
})

test('der Wechsel von AND auf OR in einer Allowlist wird gemeldet', () => {
  // Danach genügt jedes Kriterium für sich. Im Diff steht sonst nichts davon.
  const findings = check(`
diff --git a/.gitleaks.toml b/.gitleaks.toml
--- a/.gitleaks.toml
+++ b/.gitleaks.toml
@@ -32,1 +32,1 @@
 [[allowlists]]
-condition = "AND"
+condition = "OR"
`)
  assert.deepEqual(rules(findings), ['allowlist.extended'])
})

test('der Null-SHA gilt als leere Basis, eine echte Referenz nicht', () => {
  // GitHub setzt ihn in github.event.before, wenn es keinen Stand vor dem Push
  // gibt. Kurzformen zählen mit, weil git Kennungen auch gekürzt ausgibt.
  assert.equal(isNullRef('0'.repeat(40)), true)
  assert.equal(isNullRef('0000000'), true)
  assert.equal(isNullRef(`  ${'0'.repeat(40)}  `), true)
  assert.equal(isNullRef('b1c9359'), false)
  assert.equal(isNullRef('origin/main'), false)
  assert.equal(isNullRef(''), false)
  assert.equal(isNullRef(null), false)
})

test('eine Null-SHA-Basis überspringt den Lauf, statt an git zu scheitern', () => {
  // Der erste Push eines Branches. Wichtig ist nicht nur, dass es keinen
  // Fehler gibt: der Lauf darf auch nicht in den lokalen Modus fallen — der
  // prüfte in CI den uncommitteten Stand und meldete grün.
  const root = gitFixture('// @ts-ignore\nconst a = 1\n')
  try {
    assert.equal(runTamper({ root, base: '0'.repeat(40), quiet: true }), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('eine unauffindbare Basis bleibt ein Fehler und nennt beide Ursachen', () => {
  const root = gitFixture('const a = 1\n')
  try {
    assert.throws(
      () => runTamper({ root, base: 'origin/main', quiet: true }),
      (err) => {
        assert.ok(err instanceof Error)
        assert.match(err.message, /nicht auffindbar/)
        assert.match(err.message, /fetch-depth: 0/)
        assert.match(err.message, /Force-Push/)
        return true
      },
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Python-Suppression im Quellcode wird gemeldet', () => {
  const findings = check(`
diff --git a/tools/analyse/core/regeln.py b/tools/analyse/core/regeln.py
--- a/tools/analyse/core/regeln.py
+++ b/tools/analyse/core/regeln.py
@@ -3,1 +3,2 @@
 def bewerte(zeile):
+    return zeile.wert  # type: ignore[attr-defined]
`)
  assert.deepEqual(rules(findings), ['suppression.python'])
})

test('noqa nimmt eine Zeile aus der Pruefung und wird gemeldet', () => {
  const findings = check(`
diff --git a/tools/analyse/cli.py b/tools/analyse/cli.py
--- a/tools/analyse/cli.py
+++ b/tools/analyse/cli.py
@@ -1,1 +1,2 @@
 import sys
+import os, json  # noqa: E401
`)
  assert.deepEqual(rules(findings), ['suppression.python'])
})

test('ein gewoehnlicher Python-Kommentar ist kein Fund', () => {
  const findings = check(`
diff --git a/tools/analyse/cli.py b/tools/analyse/cli.py
--- a/tools/analyse/cli.py
+++ b/tools/analyse/cli.py
@@ -1,1 +1,2 @@
 import sys
+# Die Reihenfolge zaehlt: Basis vor Vergleich.
`)
  assert.deepEqual(findings, [])
})

test('stillgelegter pytest-Fall wird gemeldet', () => {
  const findings = check(`
diff --git a/tools/analyse/tests/test_regeln.py b/tools/analyse/tests/test_regeln.py
--- a/tools/analyse/tests/test_regeln.py
+++ b/tools/analyse/tests/test_regeln.py
@@ -4,1 +4,2 @@
 import pytest
+@pytest.mark.skip(reason="spaeter")
`)
  assert.deepEqual(rules(findings), ['test.skipped'])
})

test('xfail zaehlt wie ein uebersprungener Test', () => {
  // Ein xfail-Test faellt nicht mehr auf, wenn er bricht — dieselbe Wirkung
  // wie skip, nur unauffaelliger.
  const findings = check(`
diff --git a/tools/analyse/tests/test_regeln.py b/tools/analyse/tests/test_regeln.py
--- a/tools/analyse/tests/test_regeln.py
+++ b/tools/analyse/tests/test_regeln.py
@@ -4,1 +4,2 @@
 import pytest
+@pytest.mark.xfail
`)
  assert.deepEqual(rules(findings), ['test.skipped'])
})

test('das Wort skip im Python-Produktivcode ist kein Fund', () => {
  const findings = check(`
diff --git a/tools/analyse/core/lauf.py b/tools/analyse/core/lauf.py
--- a/tools/analyse/core/lauf.py
+++ b/tools/analyse/core/lauf.py
@@ -1,1 +1,2 @@
 def lauf():
+    return itertools.islice(zeilen, skip, None)
`)
  assert.deepEqual(findings, [])
})

test('netto entfernte Python-Assertions werden gemeldet', () => {
  // Pythons nacktes `assert x == 1` hat weder Klammer noch Punkt. Ohne eine
  // eigene Alternative im Muster faellt genau der haeufigste Fall durch.
  const findings = check(`
diff --git a/tools/analyse/tests/test_regeln.py b/tools/analyse/tests/test_regeln.py
--- a/tools/analyse/tests/test_regeln.py
+++ b/tools/analyse/tests/test_regeln.py
@@ -10,4 +10,2 @@
 def test_summe():
-    assert summe([1, 2]) == 3
-    assert summe([]) == 0
     pass
`)
  assert.deepEqual(rules(findings), ['test.assertions-removed'])
})

test('umformulierte Python-Assertions sind kein Fund', () => {
  const findings = check(`
diff --git a/tools/analyse/tests/test_regeln.py b/tools/analyse/tests/test_regeln.py
--- a/tools/analyse/tests/test_regeln.py
+++ b/tools/analyse/tests/test_regeln.py
@@ -10,2 +10,2 @@
 def test_summe():
-    assert summe([1, 2]) == 3
+    assert summe([1, 2]) == 3, "Basis"
`)
  assert.deepEqual(findings, [])
})

test('Quell- und Testmuster decken alle gepruegten Sprachen ab', () => {
  // Diese beiden Muster benutzt auch der Audit (lib/audit-run.mjs). Sie
  // standen dort einmal als eigene Kopie ohne .py — der Bericht meldete
  // daraufhin "0 Quelldateien" fuer ein Projekt voller Python und uebersah
  // jede Suppression darin. Der Test haelt die eine Quelle fest.
  for (const path of ['app/Service.php', 'src/app.ts', 'lib/run.mjs', 'tools/analyse/cli.py']) {
    assert.ok(SOURCE_FILE.test(path), `${path} sollte als Quellcode gelten`)
  }
  assert.ok(!SOURCE_FILE.test('composer.lock'))

  for (const path of [
    'tests/Feature/LoginTest.php',
    'src/app.test.ts',
    'tools/analyse/tests/test_cli.py',
    'core/regeln_test.py',
  ]) {
    assert.ok(isTestFile(path), `${path} sollte als Testdatei gelten`)
  }
  assert.ok(!isTestFile('tools/analyse/cli.py'))
})

// ── Richtungsabhängiger Schutz für Baseline-Dateien ──────────────────────────
// Eine Baseline-Zeile HINZUFÜGEN schwächt das Gate, eine LÖSCHEN stärkt es.
// Nur bei Baselines gibt es diese erwünschte Richtung; die übrigen geschützten
// Pfade bleiben streng.

test('eine Baseline, die nur Zeilen entfernt, ist kein protected.changed', () => {
  const findings = check(`
diff --git a/phpstan-baseline.neon b/phpstan-baseline.neon
--- a/phpstan-baseline.neon
+++ b/phpstan-baseline.neon
@@ -3,6 +2,0 @@
-		-
-			message: '#^Access to an undefined property A\\:\\:\\$x\\.$#'
-			identifier: property.notFound
-			count: 1
-			path: app/A.php
-
`)
  assert.deepEqual(findings, [])
})

test('eine hinzugefügte Baseline-Zeile wird weiterhin gemeldet', () => {
  const findings = check(`
diff --git a/phpstan-baseline.neon b/phpstan-baseline.neon
--- a/phpstan-baseline.neon
+++ b/phpstan-baseline.neon
@@ -2,0 +3,5 @@
+		-
+			message: '#^Neuer Fehler\\.$#'
+			identifier: property.notFound
+			count: 1
+			path: app/A.php
`)
  assert.deepEqual(rules(findings), ['protected.changed'])
})

test('ein gesenkter Zähler in der Baseline ist kein Fund', () => {
  const findings = check(`
diff --git a/phpstan-baseline.neon b/phpstan-baseline.neon
--- a/phpstan-baseline.neon
+++ b/phpstan-baseline.neon
@@ -5,1 +5,1 @@
-			count: 4
+			count: 2
`)
  assert.deepEqual(findings, [])
})

test('ein angehobener Zähler in der Baseline wird gemeldet', () => {
  const findings = check(`
diff --git a/phpstan-baseline.neon b/phpstan-baseline.neon
--- a/phpstan-baseline.neon
+++ b/phpstan-baseline.neon
@@ -5,1 +5,1 @@
-			count: 2
+			count: 4
`)
  assert.deepEqual(rules(findings), ['protected.changed'])
})

test('eine neu angelegte Baseline wird gemeldet', () => {
  // Alle Zeilen sind hinzugefügt, keine entfernt — das ist kein Schrumpfen.
  const findings = analyseDiff([
    {
      path: 'phpstan-baseline.neon',
      deleted: false,
      removed: [],
      added: ['parameters:', '\tignoreErrors:'].map((text, index) => ({ line: index + 1, text })),
    },
  ])
  assert.deepEqual(rules(findings), ['protected.changed'])
})

test('eine geänderte Baseline-Zeile mit neuem Inhalt wird gemeldet', () => {
  // Gleich viele Zeilen raus wie rein, aber das Muster ist ein anderes: damit
  // deckt die Baseline einen Fehler ab, den sie vorher nicht abdeckte.
  const findings = check(`
diff --git a/phpstan-baseline.neon b/phpstan-baseline.neon
--- a/phpstan-baseline.neon
+++ b/phpstan-baseline.neon
@@ -4,1 +4,1 @@
-			message: '#^Alt\\.$#'
+			message: '#^Neu\\.$#'
`)
  assert.deepEqual(rules(findings), ['protected.changed'])
})

test('die Richtungsregel gilt auch für die gitleaks-Baseline, trotz Komma am Zeilenende', () => {
  // Beim Entfernen des letzten Array-Elements verliert das vorherige sein
  // Komma. Diese Zeile ist inhaltlich dieselbe und darf nicht als neu zählen.
  const findings = check(`
diff --git a/gitleaks-baseline.json b/gitleaks-baseline.json
--- a/gitleaks-baseline.json
+++ b/gitleaks-baseline.json
@@ -2,2 +2,1 @@
-  {"RuleID":"generic-api-key","File":"src/a.ts"},
-  {"RuleID":"generic-api-key","File":"src/b.ts"}
+  {"RuleID":"generic-api-key","File":"src/a.ts"}
`)
  assert.deepEqual(findings, [])
})

test('die Richtungsregel gilt auch für ESLint-Suppressions', () => {
  const findings = check(`
diff --git a/eslint-suppressions.json b/eslint-suppressions.json
--- a/eslint-suppressions.json
+++ b/eslint-suppressions.json
@@ -3,1 +3,1 @@
-      "count": 9
+      "count": 3
`)
  assert.deepEqual(findings, [])
})

test('die übrigen geschützten Pfade kennen keine Richtung', () => {
  // Ein CI-Workflow oder eine Linter-Konfiguration hat keine erwünschte
  // Richtung: eine entfernte Zeile kann dort eine Prüfung abschalten.
  for (const datei of [
    '.github/workflows/quality.yml',
    'quality.yml',
    'phpstan.neon',
    'pint.json',
  ]) {
    const findings = analyseDiff([
      { path: datei, deleted: false, added: [], removed: [{ text: '      - run: quality full' }] },
    ])
    assert.deepEqual(rules(findings), ['protected.changed'], `${datei} müsste weiterhin melden`)
  }
})

/**
 * Ein echtes Repository mit einer committeten PHPStan-Baseline.
 * `change` schreibt den neuen Inhalt und committet ihn als zweiten Commit;
 * geprüft wird dann der Bereich HEAD~1...HEAD — also der CI-Modus, in dem
 * `protected.changed` bindend ist.
 *
 * @param {string} before
 * @param {string} after
 */
function baselineFixture(before, after) {
  const root = mkdtempSync(join(tmpdir(), 'quality-baseline-'))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(root, 'phpstan-baseline.neon'), before)
  git('add', '.')
  git('commit', '--quiet', '-m', 'Baseline')
  writeFileSync(join(root, 'phpstan-baseline.neon'), after)
  git('add', '.')
  git('commit', '--quiet', '-m', 'Baseline geändert')
  return root
}

const neonEntry = (/** @type {string} */ message, count = 1) =>
  [
    '\t\t-',
    `\t\t\tmessage: '${message}'`,
    '\t\t\tidentifier: property.notFound',
    `\t\t\tcount: ${count}`,
    '\t\t\tpath: app/A.php',
  ].join('\n')

const neonBaseline = (/** @type {string[]} */ ...entries) =>
  'parameters:\n\tignoreErrors:\n' + entries.join('\n\n') + '\n'

test('echter Diff: eine HINZUGEFÜGTE Baseline-Zeile meldet in CI weiterhin', () => {
  // Die Gegenprobe zur Richtungsregel. Sie läuft über git, nicht über einen
  // von Hand geschriebenen Diff — sonst prüft sie den Parser statt die Regel.
  const root = baselineFixture(
    neonBaseline(neonEntry('#^A\\.$#')),
    neonBaseline(neonEntry('#^A\\.$#'), neonEntry('#^Neu\\.$#')),
  )
  try {
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('echter Diff: eine ENTFERNTE Baseline-Zeile meldet in CI nicht mehr', () => {
  const root = baselineFixture(
    neonBaseline(neonEntry('#^A\\.$#'), neonEntry('#^Tot\\.$#')),
    neonBaseline(neonEntry('#^A\\.$#')),
  )
  try {
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('echter Diff: ein angehobener Zähler meldet in CI weiterhin', () => {
  const root = baselineFixture(
    neonBaseline(neonEntry('#^A\\.$#', 1)),
    neonBaseline(neonEntry('#^A\\.$#', 9)),
  )
  try {
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('echter Diff: ein gesenkter Zähler meldet in CI nicht mehr', () => {
  const root = baselineFixture(
    neonBaseline(neonEntry('#^A\\.$#', 9)),
    neonBaseline(neonEntry('#^A\\.$#', 1)),
  )
  try {
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('genau die drei Baselines kennen eine Richtung, sonst nichts', () => {
  // Der Punkt der Änderung ist die Unterscheidung nach Richtung, nicht weniger
  // Schutz. Diese Zusicherung hält fest, welche Pfade gemeint sind.
  const richtung = PROTECTED_PATHS.filter((p) => p.shrinkOnly).map((p) => p.label)
  assert.deepEqual(richtung, ['PHPStan-Baseline', 'gitleaks-Baseline', 'ESLint-Suppressions'])
})

/**
 * Ein package-lock.json im Format v3, wie npm es schreibt.
 *
 * @param {string} version
 * @param {string} oxlint
 */
const npmLock = (version, oxlint = '1.87.0') =>
  JSON.stringify(
    {
      name: '@standout/quality',
      version,
      lockfileVersion: 3,
      requires: true,
      packages: {
        '': { name: '@standout/quality', version, devDependencies: { oxlint: '^1.87.0' } },
        'node_modules/oxlint': { version: oxlint, dev: true },
      },
    },
    null,
    2,
  ) + '\n'

test('Lockfile: nur die eigene Version geändert, sonst nichts', () => {
  assert.equal(lockfileOnlyBumpsOwnVersion(npmLock('0.2.9'), npmLock('0.2.10')), true)
})

test('Lockfile: eigene Version und eine Abhängigkeit geändert', () => {
  assert.equal(lockfileOnlyBumpsOwnVersion(npmLock('0.2.9'), npmLock('0.2.10', '1.88.0')), false)
})

test('Lockfile: nur eine Abhängigkeit geändert', () => {
  assert.equal(lockfileOnlyBumpsOwnVersion(npmLock('0.2.9'), npmLock('0.2.9', '1.88.0')), false)
})

test('Lockfile: geänderter Paketname zählt nicht als Versionssprung', () => {
  const renamed = npmLock('0.2.10').replaceAll('@standout/quality', '@standout/anders')
  assert.equal(lockfileOnlyBumpsOwnVersion(npmLock('0.2.9'), renamed), false)
})

test('Lockfile: Format v1 trägt die Version nur oben', () => {
  /** @param {string} version */
  const v1 = (version) =>
    JSON.stringify({
      name: 'p',
      version,
      lockfileVersion: 1,
      dependencies: { a: { version: '1.0.0' } },
    })
  assert.equal(lockfileOnlyBumpsOwnVersion(v1('1.0.0'), v1('1.0.1')), true)
})

test('Lockfile: ungültiges JSON oder fehlende Fassung zählt nie als Versionssprung', () => {
  assert.equal(lockfileOnlyBumpsOwnVersion('{', npmLock('0.2.10')), false)
  assert.equal(lockfileOnlyBumpsOwnVersion(npmLock('0.2.9'), '{'), false)
  assert.equal(lockfileOnlyBumpsOwnVersion(null, npmLock('0.2.10')), false)
  assert.equal(lockfileOnlyBumpsOwnVersion('[]', '[]'), false)
})

test('Lockfile: ein reiner Versionssprung meldet nicht', () => {
  const findings = analyseDiff([
    { path: 'package-lock.json', added: [], removed: [], deleted: false, ownVersionOnly: true },
  ])
  assert.deepEqual(findings, [])
})

test('Lockfile: die Markierung gilt auch für composer.lock', () => {
  const findings = analyseDiff([
    { path: 'composer.lock', added: [], removed: [], deleted: false, ownVersionOnly: true },
  ])
  assert.deepEqual(findings, [])
})

test('Lockfile: die Markierung gilt nicht für yarn.lock und pnpm-lock.yaml', () => {
  // Beide führen die eigene Version nicht. Eine Markierung dort ist ein Fehler.
  const findings = analyseDiff([
    { path: 'yarn.lock', added: [], removed: [], deleted: false, ownVersionOnly: true },
    { path: 'pnpm-lock.yaml', added: [], removed: [], deleted: false, ownVersionOnly: true },
  ])
  assert.deepEqual(rules(findings), ['dependency.changed', 'dependency.changed'])
})

/**
 * Ein composer.json wie in calcup: `deploy.sh tag` hebt nur `version`.
 *
 * @param {string} version
 * @param {Record<string, unknown>} [extra]
 */
const composerJson = (version, extra = {}) =>
  JSON.stringify(
    {
      name: 'standout/calcup',
      version,
      require: { php: '^8.3', 'laravel/framework': '^12.0' },
      ...extra,
    },
    null,
    4,
  ) + '\n'

/**
 * @param {string} hash
 * @param {string} [laravel]
 */
const composerLock = (hash, laravel = 'v12.1.0') =>
  JSON.stringify(
    {
      _readme: ['This file locks the dependencies of your project to a known state'],
      'content-hash': hash,
      packages: [{ name: 'laravel/framework', version: laravel }],
      'packages-dev': [],
    },
    null,
    4,
  ) + '\n'

test('composer.lock: nur der content-hash zum Versionssprung geändert', () => {
  assert.equal(
    composerLockOnlyRehashes({
      lockBefore: composerLock('aaa'),
      lockAfter: composerLock('bbb'),
      manifestBefore: composerJson('2.0.50'),
      manifestAfter: composerJson('2.0.51'),
    }),
    true,
  )
})

test('composer.lock: content-hash und ein Paket geändert', () => {
  assert.equal(
    composerLockOnlyRehashes({
      lockBefore: composerLock('aaa'),
      lockAfter: composerLock('bbb', 'v12.2.0'),
      manifestBefore: composerJson('2.0.50'),
      manifestAfter: composerJson('2.0.51'),
    }),
    false,
  )
})

test('composer.lock: nur der content-hash, aber composer.json mit neuer Anforderung', () => {
  // `composer update --lock` nach einer neuen Anforderung ändert nur den
  // content-hash. Die Abhängigkeitsänderung steckt dann in composer.json.
  const require = { php: '^8.3', 'laravel/framework': '^12.0', 'guzzlehttp/guzzle': '^7.0' }
  assert.equal(
    composerLockOnlyRehashes({
      lockBefore: composerLock('aaa'),
      lockAfter: composerLock('bbb'),
      manifestBefore: composerJson('2.0.50'),
      manifestAfter: composerJson('2.0.50', { require }),
    }),
    false,
  )
})

test('composer.lock: jedes Abhängigkeitsfeld in composer.json zählt', () => {
  for (const extra of [
    { 'require-dev': { 'phpunit/phpunit': '^11.0' } },
    { conflict: { 'x/y': '*' } },
    { replace: { 'x/y': '*' } },
    { provide: { 'x/y': '1.0' } },
    { 'minimum-stability': 'dev' },
    { 'prefer-stable': true },
    { repositories: [{ type: 'vcs', url: 'https://example.com/x.git' }] },
    { config: { platform: { php: '8.3.0' } } },
  ]) {
    assert.equal(
      composerLockOnlyRehashes({
        lockBefore: composerLock('aaa'),
        lockAfter: composerLock('bbb'),
        manifestBefore: composerJson('2.0.50'),
        manifestAfter: composerJson('2.0.51', extra),
      }),
      false,
      JSON.stringify(extra),
    )
  }
})

test('composer.lock: fehlende oder ungültige Fassung zählt nie als Versionssprung', () => {
  const ok = {
    lockBefore: composerLock('aaa'),
    lockAfter: composerLock('bbb'),
    manifestBefore: composerJson('2.0.50'),
    manifestAfter: composerJson('2.0.51'),
  }
  for (const key of /** @type {const} */ ([
    'lockBefore',
    'lockAfter',
    'manifestBefore',
    'manifestAfter',
  ])) {
    assert.equal(composerLockOnlyRehashes({ ...ok, [key]: null }), false, `${key} fehlt`)
    assert.equal(composerLockOnlyRehashes({ ...ok, [key]: '{' }), false, `${key} kein JSON`)
    assert.equal(composerLockOnlyRehashes({ ...ok, [key]: '[]' }), false, `${key} kein Objekt`)
  }
})

/**
 * Ein Repository mit zwei Commits: package-lock.json vorher und nachher.
 *
 * @param {string} before
 * @param {string} after
 */
function lockFixture(before, after) {
  const root = mkdtempSync(join(tmpdir(), 'quality-lock-'))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(root, 'package-lock.json'), before)
  git('add', '.')
  git('commit', '--quiet', '-m', 'Lockfile')
  writeFileSync(join(root, 'package-lock.json'), after)
  git('add', '.')
  git('commit', '--quiet', '--allow-empty', '-m', 'Lockfile geändert')
  return root
}

test('echter Diff: ein reiner Versionssprung im Lockfile meldet in CI nicht', () => {
  const root = lockFixture(npmLock('0.2.9'), npmLock('0.2.10'))
  try {
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('echter Diff: Versionssprung mit neuer Abhängigkeit meldet in CI weiterhin', () => {
  const root = lockFixture(npmLock('0.2.9'), npmLock('0.2.10', '1.88.0'))
  try {
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('echter Diff: ein neu angelegtes Lockfile meldet in CI weiterhin', () => {
  const root = lockFixture(npmLock('0.2.9'), npmLock('0.2.9'))
  try {
    execFileSync('git', ['rm', '--quiet', 'package-lock.json'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'weg'], { cwd: root })
    writeFileSync(join(root, 'package-lock.json'), npmLock('0.2.10'))
    execFileSync('git', ['add', '.'], { cwd: root })
    execFileSync('git', ['commit', '--quiet', '-m', 'neu'], { cwd: root })
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

/**
 * Ein Repository mit zwei Commits: composer.json und composer.lock vorher und nachher.
 *
 * @param {{ json: string, lock: string }} before
 * @param {{ json: string, lock: string }} after
 */
function composerFixture(before, after) {
  const root = mkdtempSync(join(tmpdir(), 'quality-composer-'))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  git('init', '--quiet')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  writeFileSync(join(root, 'composer.json'), before.json)
  writeFileSync(join(root, 'composer.lock'), before.lock)
  git('add', '.')
  git('commit', '--quiet', '-m', 'Lockfile')
  writeFileSync(join(root, 'composer.json'), after.json)
  writeFileSync(join(root, 'composer.lock'), after.lock)
  git('add', '.')
  git('commit', '--quiet', '--allow-empty', '-m', 'bump version to 2.0.51')
  return root
}

test('echter Diff: composer.lock mit nur neuem content-hash meldet in CI nicht', () => {
  const root = composerFixture(
    { json: composerJson('2.0.50'), lock: composerLock('aaa') },
    { json: composerJson('2.0.51'), lock: composerLock('bbb') },
  )
  try {
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 0)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('echter Diff: composer.lock mit content-hash und Paket meldet in CI weiterhin', () => {
  const root = composerFixture(
    { json: composerJson('2.0.50'), lock: composerLock('aaa') },
    { json: composerJson('2.0.51'), lock: composerLock('bbb', 'v12.2.0') },
  )
  try {
    assert.equal(runTamper({ root, base: 'HEAD~1', quiet: true }), 1)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('lokal: composer.lock mit nur neuem content-hash erzeugt keinen Hinweis', () => {
  const root = composerFixture(
    { json: composerJson('2.0.50'), lock: composerLock('aaa') },
    { json: composerJson('2.0.50'), lock: composerLock('aaa') },
  )
  writeFileSync(join(root, 'composer.json'), composerJson('2.0.51'))
  writeFileSync(join(root, 'composer.lock'), composerLock('bbb'))
  /** @type {string[]} */
  const output = []
  const original = process.stdout.write
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (/** @type {string} */ chunk) => output.push(String(chunk)) > 0
  )
  try {
    assert.equal(runTamper({ root }), 0)
  } finally {
    process.stdout.write = original
    rmSync(root, { recursive: true, force: true })
  }
  assert.match(output.join(''), /keine Umgehungsmuster/)
})

test('lokal: ein reiner Versionssprung erzeugt keinen Hinweis', () => {
  const root = lockFixture(npmLock('0.2.9'), npmLock('0.2.9'))
  writeFileSync(join(root, 'package-lock.json'), npmLock('0.2.10'))
  /** @type {string[]} */
  const output = []
  const original = process.stdout.write
  process.stdout.write = /** @type {typeof process.stdout.write} */ (
    (/** @type {string} */ chunk) => output.push(String(chunk)) > 0
  )
  try {
    assert.equal(runTamper({ root }), 0)
  } finally {
    process.stdout.write = original
    rmSync(root, { recursive: true, force: true })
  }
  assert.match(output.join(''), /keine Umgehungsmuster/)
})

/**
 * Ein Repository im Zustand nach dem Merge eines Bot-PRs auf main.
 *
 * Der Bot hebt `yarn.lock` auf seinem Branch an. Ein Mensch merged per
 * Merge-Commit. `mergeEdit` schreibt zusätzlichen Inhalt in den Merge-Commit
 * selbst. `conflict` ändert `yarn.lock` vorher auch auf main; der Mensch löst
 * den Konflikt mit der Fassung des Bots. Zurück kommt der Stand vor dem Merge
 * als `base` — im Push-Lauf ist das `github.event.before`.
 *
 * @param {{ mergeEdit?: string, conflict?: boolean }} [options]
 */
function botMergeFixture({ mergeEdit, conflict = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'quality-botmerge-'))
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
  git('init', '--quiet', '--initial-branch=main')
  git('config', 'user.email', 'rene@example.com')
  git('config', 'user.name', 'René')
  writeFileSync(join(root, 'yarn.lock'), 'paket@1.0.0\n')
  git('add', '.')
  git('commit', '--quiet', '-m', 'Lockfile')
  git('checkout', '--quiet', '-b', 'dependabot/paket')
  writeFileSync(join(root, 'yarn.lock'), 'paket@1.0.1\n')
  git('add', '.')
  git(
    'commit',
    '--quiet',
    '--author=dependabot[bot] <49699333+dependabot[bot]@users.noreply.github.com>',
    '-m',
    'Bump paket from 1.0.0 to 1.0.1',
  )

  git('checkout', '--quiet', 'main')
  if (conflict) {
    writeFileSync(join(root, 'yarn.lock'), 'paket@1.0.2\n')
    git('commit', '--quiet', '-am', 'paket auf main angehoben')
  }
  const base = git('rev-parse', 'HEAD').trim()
  try {
    git('merge', '--quiet', '--no-ff', '--no-commit', 'dependabot/paket')
  } catch {
    // Konflikt: der Mensch übernimmt die Fassung des Bots.
    git('checkout', '--theirs', 'yarn.lock')
    git('add', 'yarn.lock')
  }
  if (mergeEdit) {
    writeFileSync(join(root, 'yarn.lock'), `paket@1.0.1\n${mergeEdit}\n`)
    git('add', '.')
  }
  git('commit', '--quiet', '-m', 'Merge pull request #57 from dependabot/paket')
  return { root, base }
}

/**
 * Führt `fn` mit einem menschlichen `GITHUB_ACTOR` aus — wie im Push-Lauf
 * nach dem Merge. Der alte Wert kommt danach zurück.
 *
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function asHumanActor(fn) {
  const before = process.env.GITHUB_ACTOR
  process.env.GITHUB_ACTOR = 'renestandout'
  try {
    return fn()
  } finally {
    if (before === undefined) delete process.env.GITHUB_ACTOR
    else process.env.GITHUB_ACTOR = before
  }
}

test('Push-Lauf: ein Merge-Commit ohne eigene Änderung hebt die Bot-Ausnahme nicht auf', () => {
  // Realfall adboard PR #57: PR-Lauf grün, Merge b0cfca3 auf main rot.
  const { root, base } = botMergeFixture()
  try {
    assert.equal(
      asHumanActor(() => runTamper({ root, base, quiet: true })),
      0,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Push-Lauf: eine eigene Änderung im Merge-Commit schaltet die Bot-Ausnahme ab', () => {
  // Was der Mensch im Merge-Commit selbst schreibt, hat kein Bot geschrieben.
  const { root, base } = botMergeFixture({ mergeEdit: 'fremd@6.6.6' })
  try {
    assert.equal(
      asHumanActor(() => runTamper({ root, base, quiet: true })),
      1,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Push-Lauf: ein menschlicher Commit neben dem Bot-Commit schaltet die Ausnahme ab', () => {
  const { root, base } = botMergeFixture()
  try {
    writeFileSync(join(root, 'yarn.lock'), 'paket@1.0.1\nfremd@6.6.6\n')
    execFileSync('git', ['commit', '--quiet', '-am', 'nachgeschoben'], { cwd: root })
    assert.equal(
      asHumanActor(() => runTamper({ root, base, quiet: true })),
      1,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('Push-Lauf: ein Konflikt, gelöst mit der Fassung des Bots, schaltet die Ausnahme ab', () => {
  // `git diff-tree --cc` zeigt diese Lösung nicht, weil das Ergebnis einer
  // Elternseite gleicht. Die Entscheidung im Konflikt hat trotzdem der Mensch
  // getroffen, nicht der Bot.
  const { root, base } = botMergeFixture({ conflict: true })
  try {
    assert.equal(
      asHumanActor(() => runTamper({ root, base, quiet: true })),
      1,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('PR-Lauf: «Update branch» eines Menschen hebt die Bot-Ausnahme nicht auf', () => {
  // Der Mensch merged main in den Bot-Branch, ohne eigene Änderung. Der Lauf
  // prüft den Bot-Branch gegen main.
  const { root } = botMergeFixture()
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync('git', args, { cwd: root, stdio: 'ignore' })
  try {
    git('checkout', '--quiet', 'main')
    git('reset', '--quiet', '--hard', 'HEAD~1')
    writeFileSync(join(root, 'README.md'), 'neu\n')
    git('add', '.')
    git('commit', '--quiet', '-m', 'README')
    git('checkout', '--quiet', 'dependabot/paket')
    git('merge', '--quiet', '--no-ff', '--no-edit', 'main')
    assert.equal(
      asHumanActor(() => runTamper({ root, base: 'main', quiet: true })),
      0,
    )
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
