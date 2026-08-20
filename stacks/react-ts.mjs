import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  LINT_STRICT_FLAG,
  findBinary,
  hasOnPath,
  lintStrictArgs,
  missingToolHint,
  packageManagerFor,
  scriptCommand,
} from '../lib/tools.mjs'

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

/**
 * Ruft ein Skript des Projekts auf — mit dem Paketmanager des Projekts.
 *
 * Fehlt dieser Paketmanager im PATH, läuft das Skript mit npm weiter und der
 * Schritt sagt es. Ein abgebrochener Schritt wäre hier der schlechtere
 * Tausch: das Skript selbst läuft auch unter npm, nur die Umgebung stimmt
 * nicht ganz.
 */
function runScript(script, ctx, label, extraArgs = []) {
  const wanted = packageManagerFor(ctx.dir, ctx.root) ?? 'npm'
  const pm = hasOnPath(wanted) ? wanted : 'npm'
  const { cmd, args } = scriptCommand(pm, script, extraArgs)
  return {
    name: `${label} (${ctx.component.path})`,
    cmd,
    args,
    cwd: ctx.dir,
    note: pm === wanted ? undefined : `${wanted} fehlt im PATH — das Skript läuft mit npm`,
  }
}

/**
 * Das lint-Skript des Projekts, unter "strict" um die passende Option
 * ergänzt. Erkennt das Framework den Linter nicht, bleibt das Skript
 * unverändert und der Schritt meldet, dass strict hier nicht greift.
 */
function lintScript(ctx, scriptText) {
  const strict = ctx.config?.level === 'strict'
  const extra = strict ? lintStrictArgs(scriptText) : null
  const step = runScript('lint', ctx, 'lint', extra ?? [])
  if (strict && !extra) {
    step.note = 'strict nicht erzwungen — Linter im lint-Skript nicht erkannt'
  }
  return step
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
    // Sind einzelne Dateien gemeint (Editor-Hook), muss der Linter direkt
    // aufgerufen werden: ein npm-Skript nimmt keine Dateiargumente entgegen
    // und würde jedes Mal das ganze Projekt prüfen — im Hook-Betrieb wäre das
    // um Grössenordnungen zu teuer und dazu das falsche Ergebnis.
    const wantsFiles = Boolean(ctx.files?.length)
    const scripts = packageScripts(ctx.dir)

    if (!wantsFiles && scripts.lint) return lintScript(ctx, scripts.lint)

    // Beide Linter melden Regelverstösse standardmässig als Warnung und
    // beenden mit 0 — ein Gate, das darauf hört, meldet nie etwas. Unter
    // "strict" zählen Warnungen deshalb als Fehler.
    const strict = ctx.config?.level === 'strict'
    for (const [tool, fallbackArgs] of [
      ['oxlint', []],
      ['eslint', ['.']],
    ]) {
      const bin = findBinary(tool, { dir: ctx.dir, root: ctx.root, kind: 'js' })
      if (bin) {
        return {
          name: `${tool} (${ctx.component.path})`,
          cmd: bin,
          args: [...(strict ? [LINT_STRICT_FLAG[tool]] : []), ...(wantsFiles ? ctx.files : fallbackArgs)],
          cwd: ctx.dir,
        }
      }
    }

    // Kein eigenes Binary auffindbar: dann ist das Projekt-Skript besser als nichts.
    if (scripts.lint) return lintScript(ctx, scripts.lint)
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
    if (scripts.test) return runScript('test', ctx, 'tests')
    return { name: 'tests', skip: 'weder vitest noch ein test-Skript gefunden' }
  },

  build(ctx) {
    const scripts = packageScripts(ctx.dir)
    if (!scripts.build) return { name: 'build', skip: 'kein build-Skript' }
    return runScript('build', ctx, 'build')
  },
}
