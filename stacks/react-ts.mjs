import { execFileSync } from 'node:child_process'
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

/** @import { Stack, StackContext, Step } from '../lib/types.mjs' */

/**
 * TypeScript-Stacks (react-ts, next-ts, node-ts).
 *
 * Der Linter des Projekts wird bewusst nicht ersetzt: adboard nutzt oxlint,
 * andere eslint-config-next. Existiert ein "lint"-Skript, wird es aufgerufen;
 * sonst greift oxlint, falls vorhanden. Beigesteuert wird nur, was fehlt —
 * Formatierung und tsconfig-Basis.
 */

/**
 * @param {string} dir
 * @returns {Record<string, string>}
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
 *
 * @param {string} script
 * @param {StackContext} ctx
 * @param {string} label
 * @param {string[]} [extraArgs]
 * @returns {Step}
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
 *
 * @param {StackContext} ctx
 * @param {string} scriptText
 * @returns {Step}
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

/**
 * Ungetrackte Pfade, die nur .git/info/exclude ausschliesst, relativ zu dir.
 *
 * Das Board legt WORKER.md in jedem Worktree an und schliesst sie dort aus.
 * prettier liest nur .gitignore und .prettierignore und prüfte die Datei sonst
 * mit. --ignore-path hilft nicht: prettier löst die Muster relativ zu
 * .git/info auf. Ein Muster wie "/WORKER.md" griffe dann nie, und ein Muster,
 * das auf einen Elternordner des Worktrees passt, nähme alles aus der Prüfung.
 * Deshalb wertet git die Muster aus und liefert konkrete Pfade.
 *
 * --directory fasst einen ganz ausgeschlossenen Ordner zu einem Eintrag mit
 * Schrägstrich am Ende zusammen. Ohne die Option listete git in resplan jede
 * Datei unter node_modules einzeln: über 1 MB Ausgabe und zu viele Argumente
 * für den prettier-Aufruf.
 *
 * Ohne git oder ausserhalb eines Repos ist die Liste leer. Scheitert git
 * danach, nennt `problem` den Grund.
 *
 * @param {string} dir
 * @returns {{ paths: string[], problem?: string }}
 */
function excludedByGit(dir) {
  /** @param {string[]} args */
  const git = (args) => execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: 'pipe' })
  let exclude
  try {
    // Im verknüpften Worktree liegt info/exclude im gemeinsamen git-Verzeichnis.
    const common = git(['rev-parse', '--path-format=absolute', '--git-common-dir']).trim()
    exclude = join(common, 'info', 'exclude')
  } catch {
    return { paths: [] }
  }
  if (!existsSync(exclude)) return { paths: [] }
  try {
    const out = git([
      'ls-files',
      '-z',
      '--others',
      '--ignored',
      '--directory',
      `--exclude-from=${exclude}`,
    ])
    return { paths: out.split('\0').filter(Boolean) }
  } catch (error) {
    const reason = /** @type {NodeJS.ErrnoException & { stderr?: string }} */ (error)
    const detail = reason.stderr?.trim() || reason.code || reason.message
    return { paths: [], problem: `.git/info/exclude nicht ausgewertet (${detail})` }
  }
}

/**
 * Ein Pfad aus excludedByGit als prettier-Negation. Ein Ordner braucht "/**":
 * prettier wertet "!ordner/" nicht aus und prüfte den Inhalt weiter.
 *
 * @param {string} path
 * @returns {string}
 */
function negation(path) {
  return path.endsWith('/') ? `!${escapeGlob(path)}**` : `!${escapeGlob(path)}`
}

/**
 * Maskiert die Zeichen, die prettier in einem Argument als Glob liest.
 *
 * @param {string} path
 * @returns {string}
 */
function escapeGlob(path) {
  return path.replace(/[\\*?[\]{}()!+@]/g, '\\$&')
}

/** @satisfies {Stack} */
export default {
  name: 'react-ts',
  kind: 'js',

  /** @param {StackContext} ctx */
  fmt(ctx) {
    const tool = findBinary('prettier', { dir: ctx.dir, root: ctx.root, kind: 'js' })
    if (!tool) return { name: 'prettier', skip: missingToolHint('prettier', 'js') }
    const { paths: excluded, problem } = excludedByGit(ctx.dir)
    // Ein Eintrag mit "/" am Ende steht für den ganzen Ordner.
    /** @param {string} f */
    const isExcluded = (f) => excluded.some((p) => (p.endsWith('/') ? f.startsWith(p) : f === p))
    const targets = ctx.files?.length
      ? ctx.files.filter((f) => !isExcluded(f))
      : ['.', ...excluded.map(negation)]
    if (targets.length === 0) return { name: 'prettier', skip: 'nur Dateien aus .git/info/exclude' }
    return {
      name: `prettier${ctx.check ? ' (prüfend)' : ''} (${ctx.component.path})`,
      cmd: tool,
      args: [ctx.check ? '--check' : '--write', '--ignore-unknown', ...targets],
      cwd: ctx.dir,
      note: problem,
    }
  },

  /** @param {StackContext} ctx */
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
    /** @type {Array<['oxlint' | 'eslint', string[]]>} */
    const linters = [
      ['oxlint', []],
      ['eslint', ['.']],
    ]
    for (const [tool, fallbackArgs] of linters) {
      const bin = findBinary(tool, { dir: ctx.dir, root: ctx.root, kind: 'js' })
      if (bin) {
        return {
          name: `${tool} (${ctx.component.path})`,
          cmd: bin,
          args: [
            ...(strict ? [LINT_STRICT_FLAG[tool]] : []),
            ...(wantsFiles && ctx.files ? ctx.files : fallbackArgs),
          ],
          cwd: ctx.dir,
        }
      }
    }

    // Kein eigenes Binary auffindbar: dann ist das Projekt-Skript besser als nichts.
    if (scripts.lint) return lintScript(ctx, scripts.lint)
    return { name: 'lint', skip: 'kein lint-Skript, oxlint oder eslint gefunden' }
  },

  /** @param {StackContext} ctx */
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

  /** @param {StackContext} ctx */
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

  /** @param {StackContext} ctx */
  build(ctx) {
    const scripts = packageScripts(ctx.dir)
    if (!scripts.build) return { name: 'build', skip: 'kein build-Skript' }
    return runScript('build', ctx, 'build')
  },
}
