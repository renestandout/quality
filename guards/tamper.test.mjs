import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SOFT_LOCALLY, analyseDiff, findException, parseDiff } from './tamper.mjs'

const diff = (body) => parseDiff(body.trimStart())

function check(body, options) {
  return analyseDiff(diff(body), options)
}

const rules = (findings) => findings.map((f) => f.rule)

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
  assert.equal(files[0].path, 'src/a.ts')
  assert.deepEqual(files[0].added, [{ line: 11, text: 'const neu = 2' }])
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
  assert.equal(findings[0].line, 2)
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
  assert.equal(findings[0].path, 'tests/Unit/ScoreTest.php')
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
  assert.equal(findings[0].label, "CI-Workflow geändert")
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
  assert.equal(wurzel[0].label, "Quality-Konfiguration geändert")

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
  assert.deepEqual(rules(findings).sort(), ['suppression.typescript', 'test.focused', 'test.skipped'])
})

test('findException erkennt den Trailer', () => {
  assert.equal(findException(['feat: x\n\nQuality-Exception: Test hängt an externer API']), 'Test hängt an externer API')
  assert.equal(findException(['feat: x\n\nquality-exception: kleingeschrieben']), 'kleingeschrieben')
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
    { path: 'node_modules/foo/index.js', added: [{ line: 1, text: '// eslint-disable' }], deleted: false },
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
    const findings = analyseDiff([{ path: datei, added: [{ line: 1, text: '// gelockert' }], deleted: false }])
    assert.deepEqual(
      findings.map((f) => f.rule),
      ['protected.changed'],
      `${datei} müsste geschützt sein, ist es aber nicht`
    )
  }
})

test('eine gleichnamige Quelldatei ist keine Konfiguration', () => {
  // Die Erweiterung um [cm]? darf nicht dazu führen, dass alles mit ähnlichem
  // Namen als Konfiguration gilt.
  for (const datei of ['src/eslint.config.helper.mjs', 'eslint.configuration.mjs', 'my-eslint.config.mjsx']) {
    const findings = analyseDiff([{ path: datei, added: [{ line: 1, text: 'const a = 1' }], deleted: false }])
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
    'derselbe Diff von Hand müsste weiterhin melden'
  )
})

test('die Bot-Ausnahme gilt nicht für Suppressions und stillgelegte Tests', () => {
  // Der Schutz vor Gate-Umgehung darf nicht daran hängen, wer den Commit
  // signiert hat. Nur die maschinellen Versionsbumps sind gemeint.
  const findings = analyseDiff(
    [
      { path: 'src/A.ts', added: [{ line: 3, text: '// @ts-ignore' }], deleted: false },
      { path: 'tests/AT.php', added: [{ line: 9, text: '$this->markTestSkipped();' }], deleted: false },
      { path: 'tests/Weg.php', deleted: true, added: [] },
    ],
    { botAuthor: true }
  )
  assert.deepEqual(findings.map((f) => f.rule).sort(), ['suppression.typescript', 'test.deleted', 'test.skipped'].sort())
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
  assert.equal(findings[0].line, 2)
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
    files[0].removed.map((r) => r.text),
    ['assert.equal(x, 1)']
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
  assert.match(findings[0].detail, /2/)
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
