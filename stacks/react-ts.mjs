import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findBinary, missingToolHint } from '../lib/tools.mjs'

/**
 * TypeScript-Stacks (react-ts, next-ts, node-ts).
 *
 * Der Linter des Projekts wird bewusst nicht ersetzt: adboard nutzt oxlint,
 * andere eslint-config-next. Existiert ein "lint"-Skript, wird es aufgerufen;
 * sonst greift oxlint, falls vorhanden. Beigesteuert wird nur, was fehlt —
 * Formatierung und tsconfig-Basis.
 */

function packageScripts(dir) {
  const file = join(dir, 'package.json')
  if (!existsSync(file)) return {}
  try {
    return JSON.parse(readFileSync(file, 'utf8')).scripts ?? {}
  } catch {
    return {}
  }
}

function npmRun(script, ctx, label) {
  return { name: `${label} (${ctx.component.path})`, cmd: 'npm', args: ['run', '--silent', script], cwd: ctx.dir }
}

export default {
  name: 'react-ts',
  kind: 'js',

  fmt(ctx) {
    const tool = findBinary('prettier', { dir: ctx.dir, root: ctx.root, kind: 'js' })
    if (!tool) return { name: 'prettier', skip: missingToolHint('prettier', 'js') }
    const targets = ctx.files?.length ? ctx.files : ['.']
    return {
      name: `prettier${ctx.check ? ' (prüfend)' : ''} (${ctx.component.path})`,
      cmd: tool,
      args: [ctx.check ? '--check' : '--write', '--ignore-unknown', ...targets],
      cwd: ctx.dir,
    }
  },

  lint(ctx) {
    const scripts = packageScripts(ctx.dir)
    if (scripts.lint) return npmRun('lint', ctx, 'lint')
    const oxlint = findBinary('oxlint', { dir: ctx.dir, root: ctx.root, kind: 'js' })
    if (oxlint) {
      return {
        name: `oxlint (${ctx.component.path})`,
        cmd: oxlint,
        args: ctx.files?.length ? ctx.files : [],
        cwd: ctx.dir,
      }
    }
    const eslint = findBinary('eslint', { dir: ctx.dir, root: ctx.root, kind: 'js' })
    if (eslint) {
      return {
        name: `eslint (${ctx.component.path})`,
        cmd: eslint,
        args: ctx.files?.length ? ctx.files : ['.'],
        cwd: ctx.dir,
      }
    }
    return { name: 'lint', skip: 'kein lint-Skript, oxlint oder eslint gefunden' }
  },

  types(ctx) {
    const tool = findBinary('tsc', { dir: ctx.dir, root: ctx.root, kind: 'js' })
    if (!tool) return { name: 'tsc', skip: missingToolHint('tsc', 'js') }
    // Projektreferenzen (tsconfig.app.json / tsconfig.node.json) brauchen den
    // Build-Modus; ohne sie genügt --noEmit auf der Wurzelkonfiguration.
    const hasReferences = (() => {
      const file = join(ctx.dir, 'tsconfig.json')
      if (!existsSync(file)) return false
      return /"references"\s*:/.test(readFileSync(file, 'utf8'))
    })()
    return {
      name: `tsc (${ctx.component.path})`,
      cmd: tool,
      args: hasReferences ? ['-b', '--noEmit'] : ['--noEmit'],
      cwd: ctx.dir,
    }
  },

  test(ctx) {
    if (ctx.component.testCommand) {
      const [cmd, ...args] = ctx.component.testCommand.split(' ')
      return { name: `tests (${ctx.component.path})`, cmd, args, cwd: ctx.dir }
    }
    const vitest = findBinary('vitest', { dir: ctx.dir, root: ctx.root, kind: 'js' })
    if (vitest) {
      const args = ['run']
      // vitest kann gezielt die Tests laufen lassen, die von den geänderten
      // Dateien abhängen — das spart im Hook-Betrieb den Grossteil der Zeit.
      if (ctx.files?.length) args.push('--related', ...ctx.files)
      return { name: `vitest (${ctx.component.path})`, cmd: vitest, args, cwd: ctx.dir }
    }
    const scripts = packageScripts(ctx.dir)
    if (scripts.test) return npmRun('test', ctx, 'tests')
    return { name: 'tests', skip: 'weder vitest noch ein test-Skript gefunden' }
  },

  build(ctx) {
    const scripts = packageScripts(ctx.dir)
    if (!scripts.build) return { name: 'build', skip: 'kein build-Skript' }
    return npmRun('build', ctx, 'build')
  },
}
