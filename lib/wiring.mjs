/**
 * Prüft, ob ein Projekt die Konfigurationen des Pakets tatsächlich einbindet.
 *
 * Der Anlass: rankscan/application führte das Gate ein, behielt seine
 * bestehende `phpstan.neon` — und band die Paket-Basis nie ein. `init`
 * übersprang die Datei mit „existiert bereits" und sagte nichts weiter, also
 * lief das Projekt vier Wochen mit einer Konfiguration, die nur zufällig
 * ähnlich war. Sichtbar wird das hier: eingebunden oder nicht ist eine
 * Tatsache, die man ablesen kann.
 *
 * Bewusst kein eigener Prüfschritt in jedem Lauf. Die Einbindung ändert sich
 * einmal pro Projektleben; als Dauerprüfung wäre sie Lärm. Sie erscheint in
 * `quality audit` und in `quality init`.
 *
 * Keine Prüfung für Pint: Pint kennt keine Konfigurationsvererbung. Ein
 * Projekt kann `configs/pint.json` nur kopieren, und eine Kopie lässt sich
 * nicht von einer eigenen Konfiguration unterscheiden.
 *
 * Reine Funktionen ohne Dateizugriff — wie `audit.mjs` gegenüber
 * `audit-run.mjs`. Der Aufrufer übergibt ein `read(pfad)`.
 */

/** Paketname im JS-Ökosystem; über die exports-Map von package.json. */
const NPM_PACKAGE = '@standout/quality'

/**
 * Pfad der Composer-Installation. Laravel-Projekte haben das Paket schon über
 * Composer; sie ein zweites Mal per npm installieren zu lassen, nur damit
 * `@standout/quality/tsconfig` auflöst, wäre Redundanz — unter vendor/ liegt
 * dieselbe Datei. Ein Verweis dorthin ist eine vollwertige Einbindung.
 */
const COMPOSER_PATH = 'vendor/standout/quality/'

/** Die Basiskonfiguration im PHP-Ökosystem, relativ zum Composer-Vendor. */
const PHPSTAN_BASE = 'configs/phpstan/base.neon'

const PHP_STACKS = ['laravel', 'php']
const JS_STACKS = ['react-ts', 'next-ts', 'node-ts']

/** Kandidatennamen in der Reihenfolge, in der die Werkzeuge selbst suchen. */
const PRETTIER_FILES = [
  '.prettierrc',
  '.prettierrc.json',
  '.prettierrc.js',
  '.prettierrc.mjs',
  'prettier.config.js',
  'prettier.config.mjs',
  'prettier.config.cjs',
  'prettier.config.ts',
]

const PHPSTAN_FILES = ['phpstan.neon', 'phpstan.neon.dist']

/** Entfernt Zeilenkommentare, damit eine auskommentierte Zeile nicht zählt. */
const withoutComments = (text, marker) =>
  text
    .split('\n')
    .filter((line) => !line.trim().startsWith(marker))
    .join('\n')

/**
 * Bindet die Datei die PHPStan-Basis ein?
 *
 * Geprüft wird auf den Dateipfad, nicht auf `vendor/standout/quality`: beim
 * Entwickeln am Paket selbst zeigt der Include relativ dorthin
 * (`../quality/configs/phpstan/base.neon`) und ist genauso gültig.
 */
export function phpstanBinds(text) {
  return withoutComments(text, '#').includes(PHPSTAN_BASE)
}

export function prettierBinds(text) {
  const wirksam = withoutComments(withoutComments(text, '//'), '#')

  return wirksam.includes(NPM_PACKAGE) || wirksam.includes(COMPOSER_PATH)
}

/**
 * tsconfig.json ist JSONC — TypeScript erlaubt Kommentare und hängende Kommas,
 * JSON.parse nicht.
 *
 * Zeichenweise statt per Regex, weil ein Regex Strings nicht von Code
 * unterscheidet. Gemessen an rankscan/application: dort öffnet `"@/*"` in den
 * compilerOptions.paths eine Blockkommentar-Sequenz, die das Glob
 * `"resources/js/**\/*.ts"` weiter unten schliesst — ein Regex-Ersatz frisst
 * alles dazwischen und die Datei gilt als unlesbar, obwohl sie gültiges JSON
 * ist. Dasselbe gilt für "https://…" und Zeilenkommentare.
 */
export function parseJsonc(text) {
  let out = ''
  let inString = false
  let escaped = false

  for (let i = 0; i < text.length; i++) {
    const char = text[i]

    if (inString) {
      out += char
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inString = false
      continue
    }

    if (char === '"') {
      inString = true
      out += char
      continue
    }

    if (char === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++
      out += '\n'
      continue
    }

    if (char === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2)
      i = end === -1 ? text.length : end + 1
      continue
    }

    out += char
  }

  // Hängende Kommas: erst jetzt, wo Kommentare weg sind.
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'))
}

const extendsBindsPackage = (value) => {
  const list = Array.isArray(value) ? value : [value]

  return list.some(
    (entry) => typeof entry === 'string' && (entry.startsWith(NPM_PACKAGE) || entry.includes(COMPOSER_PATH))
  )
}

/**
 * Welche Komponenten geprüft werden.
 *
 * Eine vorhandene quality.yml hat Vorrang: rankscan/application führt zwei
 * Komponenten auf demselben Pfad (laravel und react-ts), weil die automatische
 * Erkennung bei composer.json neben package.json nur das PHP-Projekt sieht
 * (lib/detect.mjs). Prüfte die Einbindung nur die erkannten, blieben Prettier
 * und tsconfig genau dort ungeprüft, wo zwei Ökosysteme in einem Verzeichnis
 * liegen — der Fall, für den die Prüfung am nützlichsten ist.
 *
 * @param {Array<{path: string, stack: string}>} declared  aus quality.yml
 * @param {Array<{path: string, stack: string}>} detected  aus lib/detect.mjs
 */
export function componentsForWiring(declared, detected) {
  const source = declared?.length ? declared : (detected ?? [])
  return source.map(({ path, stack }) => ({ path, stack }))
}

/**
 * Prüft eine Komponente auf alle für ihren Stack sinnvollen Einbindungen.
 *
 * @param {object} args
 * @param {Array<{path: string, stack: string}>} args.components
 * @param {(path: string) => string|null} args.read  Dateiinhalt oder null
 * @param {Record<string, string>} [args.configs]  z.B. { prettier: 'own' }
 * @returns {Array<{component: string, check: string, status: string, file: string, hint: string}>}
 */
export function inspectWiring({ components, read, configs = {} }) {
  const findings = []

  for (const component of components) {
    const prefix = component.path === '.' || component.path === '' ? '' : `${component.path}/`
    const at = (file) => `${prefix}${file}`

    const first = (candidates) => {
      for (const file of candidates) {
        const text = read(at(file))
        if (text !== null) return { file: at(file), text }
      }
      return null
    }

    const add = (check, status, file, hint) => findings.push({ component: component.path, check, status, file, hint })

    // Eine fehlende Datei ist hier kein Befund: sie anzulegen ist Aufgabe von
    // `init`, und derselbe Hinweis zweimal im Bericht hilft niemandem.
    if (PHP_STACKS.includes(component.stack) && configs.phpstan !== 'own') {
      const found = first(PHPSTAN_FILES)
      if (found && !phpstanBinds(found.text)) {
        add(
          'phpstan',
          'missing',
          found.file,
          `bindet ${PHPSTAN_BASE} nicht ein — ohne die Basis fehlen ` +
            'reportUnmatchedIgnoredErrors, treatPhpDocTypesAsCertain: false und die excludePaths. ' +
            `Zeile "- vendor/standout/quality/${PHPSTAN_BASE}" unter includes: ergänzen, nach Larastan.`
        )
      }
    }

    if (JS_STACKS.includes(component.stack)) {
      if (configs.prettier !== 'own') {
        const found = first(PRETTIER_FILES)
        if (found && !prettierBinds(found.text)) {
          add(
            'prettier',
            'missing',
            found.file,
            `erweitert weder ${NPM_PACKAGE}/prettier noch ${COMPOSER_PATH}configs/prettier.config.js. ` +
              'Ist der Stil bewusst eigen, ' +
              'schaltet "configs: { prettier: own }" in quality.yml diesen Hinweis dauerhaft ab.'
          )
        }
      }

      if (configs.tsconfig !== 'own') {
        const found = first(['tsconfig.json'])
        if (found) {
          let config
          try {
            config = parseJsonc(found.text)
          } catch {
            add('tsconfig', 'unreadable', found.file, 'lässt sich nicht lesen — auch nicht als JSONC.')
            config = null
          }

          if (config && !extendsBindsPackage(config.extends)) {
            // Eine Ebene über references weiterverfolgen: eine Wurzel-tsconfig
            // aus lauter references (adboard) hat ihr extends in den Kindern.
            const viaReference = (Array.isArray(config.references) ? config.references : []).some((reference) => {
              const target = typeof reference?.path === 'string' ? reference.path.replace(/^\.\//, '') : null
              if (!target) return false
              const text = read(at(target))
              if (text === null) return false
              try {
                return extendsBindsPackage(parseJsonc(text).extends)
              } catch {
                return false
              }
            })

            if (!viaReference) {
              add(
                'tsconfig',
                'missing',
                found.file,
                `erweitert weder ${NPM_PACKAGE}/tsconfig (oder -tsconfig-strict) noch ` +
                  `${COMPOSER_PATH}configs/tsconfig.base.json. ` +
                  'Ist das gewollt, schaltet "configs: { tsconfig: own }" in quality.yml den Hinweis ab.'
              )
            }
          }
        }
      }
    }
  }

  return findings
}
