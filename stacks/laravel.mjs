import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { findBinary, missingToolHint } from '../lib/tools.mjs'

/**
 * Laravel- und PHP-Stack.
 *
 * Formatierung übernimmt Pint, die Typprüfung PHPStan (mit Larastan für
 * Eloquent und Facades). Ein eigener Linter entfällt bewusst: was ein
 * PHP-Linter fände, findet PHPStan gründlicher.
 */

function phpstanStep(ctx, tool) {
  const configFile = ['phpstan.neon', 'phpstan.neon.dist', 'phpstan.dist.neon'].find((f) =>
    existsSync(join(ctx.dir, f))
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
  return { name: `phpstan level ${ctx.component.phpstanLevel} (${ctx.component.path})`, cmd: tool, args, cwd: ctx.dir }
}

export default {
  name: 'laravel',
  kind: 'php',

  fmt(ctx) {
    const tool = findBinary('pint', { dir: ctx.dir, root: ctx.root, kind: 'php' })
    if (!tool) return { name: 'pint', skip: missingToolHint('pint', 'php') }
    const args = []
    if (ctx.check) args.push('--test')
    if (ctx.files?.length) args.push(...ctx.files)
    else if (!ctx.full) args.push('--dirty')
    return { name: `pint${ctx.check ? ' (prüfend)' : ''} (${ctx.component.path})`, cmd: tool, args, cwd: ctx.dir }
  },

  lint() {
    return null
  },

  types(ctx) {
    const tool = findBinary('phpstan', { dir: ctx.dir, root: ctx.root, kind: 'php' })
    if (!tool) return { name: 'phpstan', skip: missingToolHint('phpstan', 'php') }
    return phpstanStep(ctx, tool)
  },

  test(ctx) {
    if (ctx.component.testCommand) {
      const [cmd, ...args] = ctx.component.testCommand.split(' ')
      return { name: `tests (${ctx.component.path})`, cmd, args, cwd: ctx.dir }
    }
    if (existsSync(join(ctx.dir, 'artisan'))) {
      return { name: `artisan test (${ctx.component.path})`, cmd: 'php', args: ['artisan', 'test'], cwd: ctx.dir }
    }
    const phpunit = findBinary('phpunit', { dir: ctx.dir, root: ctx.root, kind: 'php' })
    if (!phpunit) return { name: 'tests', skip: 'weder artisan noch phpunit gefunden' }
    return { name: `phpunit (${ctx.component.path})`, cmd: phpunit, args: [], cwd: ctx.dir }
  },

  build() {
    return null
  },
}
