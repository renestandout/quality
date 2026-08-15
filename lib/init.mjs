/**
 * Schreibt die Konfiguration, die der Audit vorgeschlagen hat.
 *
 * `init` erfindet nichts: es übernimmt eine Empfehlung, die auf Messungen
 * beruht. Deshalb misst es entweder selbst oder liest einen vorhandenen
 * Audit-Bericht — geraten wird nie.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { renderConfigYaml } from './audit.mjs'
import { c } from './run.mjs'

/** Verzeichnisse, die PHPStan analysieren soll, in dieser Reihenfolge. */
const PHP_PATHS = ['app', 'src', 'database', 'routes']

/**
 * Findet den Include-Pfad zur Basiskonfiguration des Frameworks.
 *
 * Liegt das Paket im Repository (Composer-Installation), wird der tatsächliche
 * Pfad benutzt. Sonst wird der Pfad angenommen, der nach `composer require`
 * stimmen wird — mit einem Hinweis, denn vorher scheitert PHPStan daran.
 */
export function phpstanIncludePath(componentDir, pkgRoot, root) {
  const real = join(pkgRoot, 'configs', 'phpstan', 'base.neon')
  const fromRoot = relative(root, pkgRoot)
  const insideRepo = fromRoot !== '' && !fromRoot.startsWith('..') && !isAbsolute(fromRoot)
  if (existsSync(real) && insideRepo) {
    return { path: relative(componentDir, real), installed: true }
  }
  return { path: 'vendor/standout/quality/configs/phpstan/base.neon', installed: false }
}

export function renderPhpstanNeon({ include, larastan, phpVersionId, paths }) {
  // Larastan zuerst: die Basiskonfiguration setzt Parameter, die danach
  // gelten sollen. Umgekehrt gewönne Larastans Voreinstellung.
  const lines = ['includes:']
  if (larastan) lines.push(`    - ${larastan}`)
  lines.push(`    - ${include}`)
  lines.push('')
  lines.push('    # Nach "phpstan analyse --generate-baseline" diese Zeile aktivieren:')
  lines.push('    # - phpstan-baseline.neon')
  lines.push('')
  lines.push('parameters:')
  lines.push('    paths:')
  for (const path of paths) lines.push(`        - ${path}`)
  if (phpVersionId) lines.push(`    phpVersion: ${phpVersionId}`)
  lines.push('')
  lines.push('    # Das Level steht in quality.yml und wird von "quality" übergeben.')
  return lines.join('\n') + '\n'
}

/** PHPStan erwartet die Version als Zahl: "8.3" → 80300. */
export function phpVersionId(version) {
  if (!version) return null
  const match = String(version).match(/(\d+)\.(\d+)/)
  if (!match) return null
  return Number(match[1]) * 10000 + Number(match[2]) * 100
}

function larastanInclude(componentDir) {
  const file = join(componentDir, 'vendor', 'larastan', 'larastan', 'extension.neon')
  return existsSync(file) ? 'vendor/larastan/larastan/extension.neon' : null
}

/**
 * Erzeugt die Dateien aus einer Empfehlung.
 * Gibt zurück, was geschrieben wurde und was bewusst unberührt blieb —
 * eine bestehende Konfiguration überschreibt `init` nie von sich aus.
 */
export function applyInit(root, recommendation, { pkgRoot, force = false, dryRun = false }) {
  const written = []
  const skipped = []
  const notes = []

  const configFile = ['quality.yml', 'quality.yaml'].map((f) => join(root, f)).find(existsSync) ?? join(root, 'quality.yml')
  const configText = renderConfigYaml(recommendation)
  if (existsSync(configFile) && !force) {
    skipped.push({ file: relative(root, configFile), reason: 'existiert bereits — mit --force überschreiben' })
  } else {
    if (!dryRun) writeFileSync(configFile, configText)
    written.push({ file: relative(root, configFile), content: configText })
  }

  for (const component of recommendation.components) {
    if (!['laravel', 'php'].includes(component.stack)) continue
    const dir = resolve(root, component.path)
    const target = ['phpstan.neon', 'phpstan.neon.dist'].map((f) => join(dir, f)).find(existsSync) ?? join(dir, 'phpstan.neon')
    if (existsSync(target) && !force) {
      skipped.push({ file: relative(root, target), reason: 'existiert bereits — mit --force überschreiben' })
      continue
    }
    const paths = PHP_PATHS.filter((p) => existsSync(join(dir, p)))
    if (paths.length === 0) {
      skipped.push({ file: relative(root, target), reason: 'kein analysierbares Verzeichnis gefunden (app/, src/ …)' })
      continue
    }
    const include = phpstanIncludePath(dir, pkgRoot, root)
    if (!include.installed) {
      notes.push(
        `${relative(root, target)} verweist auf vendor/standout/quality — bis "composer require --dev standout/quality" ` +
          'gelaufen ist, findet PHPStan diese Datei nicht.'
      )
    }
    const larastan = larastanInclude(dir)
    if (component.stack === 'laravel' && !larastan) {
      notes.push(
        `${component.path}: Larastan ist nicht installiert. Ohne die Erweiterung meldet PHPStan bei Eloquent und ` +
          'Facades Fehler, die keine sind: composer require --dev larastan/larastan'
      )
    }
    const content = renderPhpstanNeon({
      include: include.path,
      larastan,
      phpVersionId: phpVersionId(component.php),
      paths,
    })
    if (!dryRun) writeFileSync(target, content)
    written.push({ file: relative(root, target), content })
  }

  return { written, skipped, notes }
}

/** Liest einen zuvor erzeugten Audit-Bericht (`quality audit --json`). */
export function loadRecommendation(file) {
  const report = JSON.parse(readFileSync(file, 'utf8'))
  if (!report?.recommendation) {
    throw new Error(`${file} enthält keine Empfehlung — stammt die Datei aus "quality audit --json"?`)
  }
  return report.recommendation
}

export function printInitResult(result, { dryRun }) {
  const write = (s) => process.stdout.write(s)
  for (const entry of result.written) {
    write(`\n${c.bold(entry.file)}${dryRun ? c.dim(' (nicht geschrieben, --dry-run)') : ''}\n`)
    write(entry.content.replace(/^/gm, '  '))
  }
  for (const entry of result.skipped) {
    write(`\n${c.yellow('○')} ${entry.file} — ${entry.reason}\n`)
  }
  if (result.notes.length > 0) {
    write('\n' + c.bold('Zu beachten') + '\n')
    for (const note of result.notes) write(`  ${c.yellow('!')} ${note}\n`)
  }
  if (!dryRun && result.written.length > 0) {
    write(
      '\n' +
        c.dim(
          'Als Nächstes: Baseline erzeugen (falls empfohlen), einmalig durchformatieren,\n' +
            'dann die CI-Vorlage aus examples/ kopieren.\n'
        )
    )
  }
}
