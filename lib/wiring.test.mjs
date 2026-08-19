import assert from 'node:assert/strict'
import { test } from 'node:test'
import { componentsForWiring, inspectWiring } from './wiring.mjs'

/** read()-Ersatz aus einer Map: nicht vorhandene Datei ergibt null. */
const reader = (files) => (path) => (path in files ? files[path] : null)

const laravel = [{ path: '.', stack: 'laravel' }]
const reactTs = [{ path: '.', stack: 'react-ts' }]

const checks = (findings) => findings.map((f) => `${f.check}:${f.status}`)

test('eine phpstan.neon ohne die Paket-Basis wird gemeldet', () => {
  // Genau der Fall rankscan/application: eine eigene phpstan.neon, die nie die
  // Basiskonfiguration eingebunden hat — init sagte nur "existiert bereits".
  const findings = inspectWiring({
    components: laravel,
    read: reader({
      'phpstan.neon': 'includes:\n    - vendor/larastan/larastan/extension.neon\n\nparameters:\n    level: 5\n',
    }),
  })
  assert.deepEqual(checks(findings), ['phpstan:missing'])
  assert.match(findings[0].hint, /configs\/phpstan\/base\.neon/)
})

test('eine phpstan.neon mit der Paket-Basis ist eingebunden', () => {
  const findings = inspectWiring({
    components: laravel,
    read: reader({
      'phpstan.neon':
        'includes:\n    - vendor/larastan/larastan/extension.neon\n    - vendor/standout/quality/configs/phpstan/base.neon\n',
    }),
  })
  assert.deepEqual(checks(findings), [])
})

test('eine auskommentierte Einbindung zählt nicht', () => {
  const findings = inspectWiring({
    components: laravel,
    read: reader({ 'phpstan.neon': 'includes:\n    # - vendor/standout/quality/configs/phpstan/base.neon\n' }),
  })
  assert.deepEqual(checks(findings), ['phpstan:missing'])
})

test('eine fehlende phpstan.neon ist kein Einbindungsbefund', () => {
  // Das ist Aufgabe von init, nicht dieser Prüfung — sonst stünde derselbe
  // Hinweis zweimal im Bericht.
  const findings = inspectWiring({ components: laravel, read: reader({}) })
  assert.deepEqual(checks(findings), [])
})

test('PHP-Prüfungen gelten nicht für einen JS-Stack', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({ 'phpstan.neon': 'parameters:\n    level: 5\n' }),
  })
  assert.deepEqual(checks(findings), [])
})

test('eine Prettier-Konfiguration ohne die Paket-Basis wird gemeldet', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({ '.prettierrc': '{ "semi": false, "printWidth": 100 }' }),
  })
  assert.deepEqual(checks(findings), ['prettier:missing'])
})

test('prettier.config.mjs, das die Paket-Basis erweitert, ist eingebunden', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({
      'prettier.config.mjs': "import base from '@standout/quality/prettier'\nexport default { ...base, semi: false }\n",
    }),
  })
  assert.deepEqual(checks(findings), [])
})

test('configs: prettier: own schweigt für immer', () => {
  // rankscan/application hat eine begründete eigene .prettierrc. Ein Hinweis,
  // den man nicht abstellen kann, wird nach dem zweiten Mal überlesen.
  const findings = inspectWiring({
    components: reactTs,
    read: reader({ '.prettierrc': '{ "semi": false }' }),
    configs: { prettier: 'own' },
  })
  assert.deepEqual(checks(findings), [])
})

test('eine tsconfig.json ohne die Paket-Basis wird gemeldet', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({ 'tsconfig.json': '{ "compilerOptions": { "strict": true } }' }),
  })
  assert.deepEqual(checks(findings), ['tsconfig:missing'])
})

test('tsconfig-Einbindung wird über references eine Ebene weiterverfolgt', () => {
  // adboard baut so: die Wurzel-tsconfig enthält nur references, das extends
  // steht in der referenzierten Datei. Ohne dieses Nachverfolgen meldet die
  // Prüfung dort einen Fehler, den es nicht gibt.
  const findings = inspectWiring({
    components: reactTs,
    read: reader({
      'tsconfig.json': '{ "files": [], "references": [{ "path": "./tsconfig.app.json" }] }',
      'tsconfig.app.json': '{ "extends": "@standout/quality/tsconfig", "include": ["src"] }',
    }),
  })
  assert.deepEqual(checks(findings), [])
})

test('references werden nur eine Ebene tief verfolgt', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({
      'tsconfig.json': '{ "references": [{ "path": "./tsconfig.app.json" }] }',
      'tsconfig.app.json': '{ "references": [{ "path": "./tsconfig.deep.json" }] }',
      'tsconfig.deep.json': '{ "extends": "@standout/quality/tsconfig" }',
    }),
  })
  assert.deepEqual(checks(findings), ['tsconfig:missing'])
})

test('die strikte Variante zählt ebenso als eingebunden', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({ 'tsconfig.json': '{ "extends": "@standout/quality/tsconfig-strict" }' }),
  })
  assert.deepEqual(checks(findings), [])
})

test('Kommentare in einer tsconfig verhindern das Lesen nicht', () => {
  // tsconfig.json ist JSONC: TypeScript erlaubt Kommentare, JSON.parse nicht.
  const findings = inspectWiring({
    components: reactTs,
    read: reader({
      'tsconfig.json': '{\n  // vom Paket geerbt\n  "extends": "@standout/quality/tsconfig"\n}\n',
    }),
  })
  assert.deepEqual(checks(findings), [])
})

test('eine unlesbare tsconfig wird als solche gemeldet, nicht als fehlende Einbindung', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({ 'tsconfig.json': '{ "extends": ' }),
  })
  assert.deepEqual(checks(findings), ['tsconfig:unreadable'])
})

test('Komponentenpfade werden dem Dateipfad vorangestellt', () => {
  const findings = inspectWiring({
    components: [{ path: 'ads-cockpit/backend', stack: 'laravel' }],
    read: reader({ 'ads-cockpit/backend/phpstan.neon': 'parameters:\n    level: 5\n' }),
  })
  assert.deepEqual(checks(findings), ['phpstan:missing'])
  assert.equal(findings[0].file, 'ads-cockpit/backend/phpstan.neon')
})

test('das Framework-Repo selbst bindet über einen relativen Pfad ein', () => {
  // Beim Entwickeln am Paket liegt es nicht unter vendor/ — der Include zeigt
  // dann relativ dorthin. Ein Fund wäre hier falsch.
  const findings = inspectWiring({
    components: laravel,
    read: reader({ 'phpstan.neon': 'includes:\n    - ../quality/configs/phpstan/base.neon\n' }),
  })
  assert.deepEqual(checks(findings), [])
})

test('Glob-Muster in include werden nicht für Kommentare gehalten', () => {
  // Gefunden an rankscan/application: "resources/js/**/*.ts" enthält die
  // Zeichenfolge /* und *? — ein naiver Kommentar-Ersatz zerstört das JSON und
  // die Datei wird als unlesbar gemeldet, obwohl sie gültiges JSON ist.
  // Die Reihenfolge ist entscheidend: "@/*" öffnet, das Glob darunter schliesst.
  const findings = inspectWiring({
    components: reactTs,
    read: reader({
      'tsconfig.json': `{
    "extends": "@standout/quality/tsconfig",
    "compilerOptions": {
        "paths": {
            "@/*": ["./resources/js/*"]
        }
    },
    "include": [
        "resources/js/**/*.ts",
        "resources/js/**/*.tsx"
    ]
}`,
    }),
  })
  assert.deepEqual(checks(findings), [])
})

test('eine URL im JSON ist kein Zeilenkommentar', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({
      'tsconfig.json': '{ "$schema": "https://json.schemastore.org/tsconfig", "extends": "@standout/quality/tsconfig" }',
    }),
  })
  assert.deepEqual(checks(findings), [])
})

test('echte Kommentare und ein hängendes Komma werden weiterhin entfernt', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({
      'tsconfig.json': `{
  /* Blockkommentar */
  // Zeilenkommentar
  "extends": "@standout/quality/tsconfig",
}`,
    }),
  })
  assert.deepEqual(checks(findings), [])
})

test('deklarierte Komponenten haben Vorrang vor den erkannten', () => {
  // rankscan/application führt zwei Komponenten auf demselben Pfad (laravel und
  // react-ts), weil die automatische Erkennung bei composer.json neben
  // package.json nur das PHP-Projekt sieht. Prüfte die Einbindung nur die
  // erkannten, blieben Prettier und tsconfig dort ungeprüft.
  const chosen = componentsForWiring(
    [
      { path: '.', stack: 'laravel' },
      { path: '.', stack: 'react-ts' },
    ],
    [{ path: '.', stack: 'laravel' }]
  )
  assert.deepEqual(chosen, [
    { path: '.', stack: 'laravel' },
    { path: '.', stack: 'react-ts' },
  ])
})

test('ohne quality.yml gelten die erkannten Komponenten', () => {
  const chosen = componentsForWiring([], [{ path: 'backend', stack: 'php' }])
  assert.deepEqual(chosen, [{ path: 'backend', stack: 'php' }])
})

test('componentsForWiring nimmt nur Pfad und Stack mit', () => {
  // Der Rest einer Komponente (phpstanLevel, testCommand …) gehört nicht hierher.
  const chosen = componentsForWiring([{ path: '.', stack: 'laravel', phpstanLevel: 5, testCommand: 'x' }], [])
  assert.deepEqual(chosen, [{ path: '.', stack: 'laravel' }])
})

test('ein Verweis auf die Composer-Installation zaehlt als Einbindung', () => {
  // Laravel-Projekte haben das Paket ueber Composer, nicht ueber npm. Ein
  // zweites Mal per npm zu installieren, nur damit "@standout/quality/tsconfig"
  // aufloest, waere Redundanz — der vendor-Pfad ist dieselbe Datei.
  const findings = inspectWiring({
    components: reactTs,
    read: reader({
      'tsconfig.json': '{ "extends": "./vendor/standout/quality/configs/tsconfig.base.json" }',
    }),
  })
  assert.deepEqual(checks(findings), [])
})

test('ein Verweis auf die Composer-Installation zaehlt auch fuer Prettier', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({
      'prettier.config.mjs':
        "import base from './vendor/standout/quality/configs/prettier.config.js'\nexport default base\n",
    }),
  })
  assert.deepEqual(checks(findings), [])
})

test('ein fremder vendor-Pfad zaehlt nicht', () => {
  const findings = inspectWiring({
    components: reactTs,
    read: reader({ 'tsconfig.json': '{ "extends": "./vendor/andere/basis/tsconfig.json" }' }),
  })
  assert.deepEqual(checks(findings), ['tsconfig:missing'])
})
