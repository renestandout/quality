import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  failingCommand,
  findBinary,
  findDdevRoot,
  missingToolHint,
  phpCommand,
  readJson,
} from '../lib/tools.mjs'

/** @import { Stack, StackContext, Step } from '../lib/types.mjs' */

/**
 * Laravel- und PHP-Stack.
 *
 * Formatierung übernimmt Pint, die Typprüfung PHPStan (mit Larastan für
 * Eloquent und Facades). Ein eigener Linter entfällt bewusst: was ein
 * PHP-Linter fände, findet PHPStan gründlicher.
 */

/** Plattform-Anforderungen: composer prüft sie, installiert sie aber nie nach vendor. */
const PLATFORM = /^(php(-64bit)?|hhvm|composer(-plugin-api|-runtime-api)?|ext-.+|lib-.+)$/

/**
 * Ein Schritt, der scheitert, weil vendor fehlt — sonst null.
 *
 * Ohne vendor entfielen pint und phpstan still. Ein PHP-Projekt ohne artisan
 * bestand das Gate mit null Prüfungen, und "artisan test" endete mit exit 255
 * ohne Hinweis auf die Ursache. Das ist eine kaputte Umgebung, keine
 * Entscheidung des Projekts. Der Schritt scheitert deshalb und sagt, wie man
 * installiert.
 *
 * Installiert heisst: mindestens ein deklariertes Paket liegt in vendor der
 * Komponente oder der Repo-Wurzel. Dieselbe Regel gilt bei den JS-Stacks für
 * node_modules. Fehlt nur ein einzelnes Werkzeug, bleibt es beim Skip.
 *
 * @param {StackContext} ctx
 * @param {string} name
 * @returns {Step | null}
 */
function uninstalledStep(ctx, name) {
  const manifest = readJson(join(ctx.dir, 'composer.json'))
  const packages = Object.keys({ ...manifest?.require, ...manifest?.['require-dev'] }).filter(
    (pkg) => !PLATFORM.test(pkg),
  )
  if (packages.length === 0) return null
  const bases = [ctx.dir, ctx.root].filter(Boolean)
  const installed = bases.some((base) =>
    packages.some((pkg) => existsSync(join(base, 'vendor', pkg))),
  )
  if (installed) return null
  // Ohne PHP auf dem Host läuft composer nur im Container.
  const install = findDdevRoot(ctx.dir) ? 'ddev composer install' : 'composer install'
  return {
    name: `${name} (${ctx.component.path})`,
    ...failingCommand(`vendor fehlt (${ctx.component.path}).\nInstallieren mit:  ${install}\n`),
    cwd: ctx.dir,
  }
}

/**
 * @param {StackContext} ctx
 * @param {string} tool
 * @returns {Step}
 */
function phpstanStep(ctx, tool) {
  const configFile = ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon'].find((f) =>
    existsSync(join(ctx.dir, f)),
  )
  if (!configFile) {
    return {
      name: `phpstan (${ctx.component.path})`,
      skip: 'keine phpstan.neon in der Komponente — "quality init" legt sie an',
    }
  }
  const args = [
    'analyse',
    '--configuration',
    configFile,
    '--level',
    String(ctx.component.phpstanLevel),
    '--memory-limit',
    '2G',
    '--no-progress',
  ]
  // Bei einem Datei-Lauf (Hook) nur die geänderten Dateien prüfen. PHPStan
  // analysiert dann zwar mit weniger Kontext, ist aber in Millisekunden fertig.
  if (ctx.files?.length) args.push(...ctx.files)
  return {
    name: `phpstan level ${ctx.component.phpstanLevel} (${ctx.component.path})`,
    ...phpCommand(tool, args, ctx.dir),
    cwd: ctx.dir,
  }
}

/** @satisfies {Stack} */
export default {
  name: 'laravel',
  kind: 'php',

  /** @param {StackContext} ctx */
  fmt(ctx) {
    const uninstalled = uninstalledStep(ctx, 'pint')
    if (uninstalled) return uninstalled
    const tool = findBinary('pint', { dir: ctx.dir, root: ctx.root, kind: 'php' })
    if (!tool) return { name: 'pint', skip: missingToolHint('pint', 'php') }
    /** @type {string[]} */
    const args = []
    if (ctx.check) args.push('--test')
    if (ctx.files?.length) args.push(...ctx.files)
    else if (!ctx.full) args.push('--dirty')
    return {
      name: `pint${ctx.check ? ' (prüfend)' : ''} (${ctx.component.path})`,
      ...phpCommand(tool, args, ctx.dir),
      cwd: ctx.dir,
    }
  },

  lint() {
    return null
  },

  /** @param {StackContext} ctx */
  types(ctx) {
    const uninstalled = uninstalledStep(ctx, 'phpstan')
    if (uninstalled) return uninstalled
    const tool = findBinary('phpstan', { dir: ctx.dir, root: ctx.root, kind: 'php' })
    if (!tool) return { name: 'phpstan', skip: missingToolHint('phpstan', 'php') }
    return phpstanStep(ctx, tool)
  },

  /** @param {StackContext} ctx */
  test(ctx) {
    if (ctx.component.testCommand) {
      // Wie Pint und PHPStan im ddev-Container, falls er läuft. Auf dem Host
      // fehlen sonst die Datenbank, das passende PHP und genug memory_limit.
      // split liefert immer mindestens ein Element.
      const [cmd, ...args] = /** @type {[string, ...string[]]} */ (
        ctx.component.testCommand.split(' ')
      )
      return {
        name: `tests (${ctx.component.path})`,
        ...phpCommand(cmd, args, ctx.dir),
        cwd: ctx.dir,
      }
    }
    const uninstalled = uninstalledStep(ctx, 'tests')
    if (uninstalled) return uninstalled
    if (existsSync(join(ctx.dir, 'artisan'))) {
      return {
        name: `artisan test (${ctx.component.path})`,
        ...phpCommand('php', ['artisan', 'test'], ctx.dir),
        cwd: ctx.dir,
      }
    }
    const phpunit = findBinary('phpunit', { dir: ctx.dir, root: ctx.root, kind: 'php' })
    if (!phpunit) return { name: 'tests', skip: 'weder artisan noch phpunit gefunden' }
    return {
      name: `phpunit (${ctx.component.path})`,
      ...phpCommand(phpunit, [], ctx.dir),
      cwd: ctx.dir,
    }
  },

  build() {
    return null
  },
}
