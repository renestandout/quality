/**
 * Stellt das Ergebnis der Bestandsaufnahme als Markdown dar.
 *
 * Bewusst nur ein Format: der Bericht wird selten erzeugt und meist
 * aufgehoben, weitergeschickt oder in ein Ticket kopiert. Markdown liest sich
 * im Terminal gut genug, und zwei Renderer wären zwei Wahrheiten darüber, was
 * gemessen wurde.
 */
import { renderConfigYaml, shortVersion } from './audit.mjs'

const nf = (n) => new Intl.NumberFormat('de-CH').format(n)

/*
 * Der Formatierer wird zweimal genannt, und das ist kein Versehen.
 *
 * Beim adboard-Rollout meldete `--check` drei Testdateien als unformatiert,
 * unmittelbar nachdem `--write .` über dasselbe Verzeichnis gelaufen war: bei
 * Methodenketten ist Prettiers Ausgabe nicht immer schon ihr eigener Fixpunkt.
 * Wer einmal schreibt und committet, bekommt ein rotes Gate auf frisch
 * formatiertem Code — und sucht den Fehler zuerst bei sich.
 *
 * Deshalb steht hier der prüfende Lauf als eigener Schritt: Er kostet Sekunden
 * und entscheidet, ob der Commit schon stimmt.
 */
const FORMAT_STEP =
  'Einmalig durchformatieren, danach prüfend gegenlesen und bei Funden ein zweites Mal ' +
  'schreiben (der erste Lauf ist nicht immer sein eigener Fixpunkt). Eigener Commit, ' +
  'wenn kein Branch offen ist.'

function severityLine(counts) {
  if (!counts || counts.total === 0) return 'keine offenen Verwundbarkeiten'
  const parts = []
  for (const [key, label] of [
    ['critical', 'kritisch'],
    ['high', 'hoch'],
    ['moderate', 'mittel'],
    ['low', 'niedrig'],
  ]) {
    if (counts[key] > 0) parts.push(`${counts[key]} ${label}`)
  }
  return `**${counts.total}** offen (${parts.join(', ')})`
}

function statusOf(result) {
  if (!result) return '—'
  if (result.skipped) return `übersprungen — ${result.reason}`
  return result.clean ? 'läuft sauber durch' : `meldet Fundstellen (exit ${result.code})`
}

function phpstanSection(entry, lines) {
  const phpstan = entry.phpstan
  if (!phpstan) return
  if (!phpstan.available) {
    lines.push(`- **PHPStan:** nicht gemessen — ${phpstan.hint}`)
    lines.push(
      `  - Der Vorschlag unten nennt trotzdem Level ${phpstan.recommendation.phpstanLevel} mit Baseline. Das ist ` +
        'die vorsichtige Annahme, keine Messung: nach der Installation den Audit wiederholen.'
    )
    return
  }
  const curve = phpstan.measurements
    .map((m) => (Number.isInteger(m.errors) ? `L${m.level}: ${nf(m.errors)}` : `L${m.level}: Messung fehlgeschlagen`))
    .join(' · ')
  lines.push(`- **PHPStan-Fehler je Level:** ${curve}`)
  if (!phpstan.larastan) {
    lines.push('  - ⚠️ Larastan war nicht installiert — bei Laravel-Code sind diese Zahlen zu hoch.')
  }
  lines.push(`  - Vorschlag: **Level ${phpstan.recommendation.phpstanLevel}** — ${phpstan.recommendation.reason}`)
  if (phpstan.topFiles?.length) {
    const sum = phpstan.topFiles.reduce((total, f) => total + f.errors, 0)
    const list = phpstan.topFiles.map((f) => `\`${f.file}\` (${f.errors})`).join(', ')
    if (phpstan.topFilesTruncated) {
      lines.push(`  - Auszug aus der Fehlerliste (gekappt, also nicht die schwersten Dateien): ${list}`)
    } else {
      const share = phpstan.countedErrors ? Math.round((sum / phpstan.countedErrors) * 100) : null
      const spread = phpstan.affectedFiles ? ` von ${nf(phpstan.affectedFiles)} betroffenen Dateien` : ''
      lines.push(`  - Schwerpunkt: ${nf(sum)} Fehler${share !== null ? ` (${share} %)` : ''} in fünf${spread} — ${list}`)
      if (share !== null && share >= 40) {
        lines.push('  - Die Fehler sind stark konzentriert: ein Umbau dieser Dateien trägt den grössten Teil der Baseline ab.')
      }
    }
  }
}

function hygieneSection(entry, lines) {
  const h = entry.hygiene
  const tests = h.testFiles === 1 ? '1 Testdatei' : `${nf(h.testFiles)} Testdateien`
  lines.push(`- **Umfang:** ${nf(h.sourceFiles)} Quelldateien, davon ${tests}`)
  if (h.rules.length === 0) {
    lines.push('- **Altbestand:** keine Suppressions, keine stillgelegten Tests')
  } else {
    lines.push('- **Altbestand:**')
    for (const rule of h.rules) {
      lines.push(`  - ${rule.label}: ${nf(rule.count)}× in ${nf(rule.files)} Datei(en)`)
    }
  }
  if (h.todos > 0) lines.push(`- **TODO/FIXME:** ${nf(h.todos)}`)
}

export function renderAudit(report, { generatedAt } = {}) {
  const lines = []
  lines.push(`# Quality-Audit`)
  lines.push('')
  lines.push(`Repository: \`${report.root}\``)
  if (generatedAt) lines.push(`Erstellt: ${generatedAt}`)
  lines.push('')

  if (report.components.length === 0) {
    lines.push('Keine Komponente erkannt — weder composer.json noch package.json gefunden.')
    lines.push('')
    lines.push('Das kann ein reines CMS- oder Inhalts-Repository sein. Dann greift vom Framework')
    lines.push('nur der Tamper-Check; eine quality.yml lohnt sich hier nicht.')
    return lines.join('\n') + '\n'
  }

  /* ── Kopf: was sofort auffällt ─────────────────────────────────────── */
  const alarms = []
  if (report.repo.secrets?.available && report.repo.secrets.count > 0) {
    alarms.push(`**${report.repo.secrets.count} mögliche Secrets in der Git-Historie** — vor allem anderen zu klären.`)
  }
  for (const comp of report.components) {
    const counts = comp.deps?.counts
    if (counts && counts.critical + counts.high > 0) {
      alarms.push(`\`${comp.path}\`: ${counts.critical + counts.high} Verwundbarkeit(en) der Stufe hoch oder kritisch.`)
    }
  }
  for (const finding of report.wiring ?? []) {
    if (finding.check === 'phpstan' && finding.status === 'missing') {
      alarms.push(
        `\`${finding.file}\` bindet die Basiskonfiguration des Pakets nicht ein — ` +
          'das Gate prüft dort mit anderen Regeln als gedacht.'
      )
    }
  }

  if (alarms.length > 0) {
    lines.push('## Zuerst')
    lines.push('')
    for (const alarm of alarms) lines.push(`- ${alarm}`)
    lines.push('')
  }

  /* ── Komponenten ───────────────────────────────────────────────────── */
  lines.push('## Komponenten')
  lines.push('')
  for (const entry of report.components) {
    lines.push(`### \`${entry.path}\` — ${entry.stack}`)
    lines.push('')
    const versions = []
    // Nur Versionen, die zum Stack gehören: ein Node-Paket kann eine
    // composer.json mitliefern, ohne dass "PHP 8.2" hier etwas aussagt.
    const isPhp = ['laravel', 'php'].includes(entry.stack)
    if (isPhp && entry.facts.php) versions.push(`PHP ${shortVersion(entry.facts.php)}`)
    if (isPhp && entry.facts.phpFrom === 'constraint') {
      lines.push(
        `- ⚠️ **PHP-Version aus dem composer.json-Constraint** (\`${entry.facts.php}\`) — das ist eine Mindestangabe, ` +
          'keine Laufzeitversion. Gegen welche gemessen wird, entscheidet das Ergebnis: bitte gegen das ' +
          'Produktions-Image prüfen und `config.platform.php` in composer.json setzen.'
      )
    }
    if (isPhp && entry.facts.laravel) versions.push(`Laravel ${shortVersion(entry.facts.laravel)}`)
    if (entry.facts.typescript) versions.push(`TypeScript ${shortVersion(entry.facts.typescript)}`)
    if (entry.facts.react) versions.push(`React ${shortVersion(entry.facts.react)}`)
    if (versions.length) lines.push(`- **Versionen:** ${versions.join(' · ')}`)

    phpstanSection(entry, lines)
    if (entry.types) lines.push(`- **Typprüfung:** ${statusOf(entry.types)}`)
    if (entry.lint) lines.push(`- **Linter:** ${statusOf(entry.lint)}`)
    if (entry.fmt) lines.push(`- **Formatierung:** ${statusOf(entry.fmt)}`)
    if (entry.deps) {
      lines.push(
        `- **Abhängigkeiten:** ${entry.deps.available ? severityLine(entry.deps.counts) : `nicht geprüft — ${entry.deps.hint}`}`
      )
    }
    hygieneSection(entry, lines)
    lines.push('')
  }

  /* ── Repository ────────────────────────────────────────────────────── */
  if ((report.wiring ?? []).length > 0) {
    lines.push('## Einbindung')
    lines.push('')
    lines.push('Konfigurationen, die das Paket mitbringt, hier aber nicht wirken:')
    lines.push('')
    for (const finding of report.wiring) {
      lines.push(`- \`${finding.file}\` ${finding.hint}`)
    }
    lines.push('')
  }

  lines.push('## Repository')
  lines.push('')
  const commits = report.repo.commits === 1 ? '1 Commit' : `${nf(report.repo.commits)} Commits`
  lines.push(`- **Branch:** ${report.repo.branch ?? 'unbekannt'} · ${commits}`)
  const secrets = report.repo.secrets
  if (!secrets?.available) {
    lines.push(`- **Secret-Scan:** nicht gelaufen — ${secrets?.hint}`)
  } else if (secrets.count === 0) {
    lines.push('- **Secret-Scan:** keine Funde über die gesamte Historie')
  } else {
    lines.push(`- **Secret-Scan:** ${nf(secrets.count)} Funde über die gesamte Historie`)
    for (const rule of secrets.rules.slice(0, 5)) lines.push(`  - ${rule.rule}: ${nf(rule.count)}`)
    lines.push('  - Ein einmal committetes Geheimnis bleibt gültig, auch wenn die Datei längst gelöscht ist: rotieren, nicht nur entfernen.')
  }
  lines.push(
    report.repo.workflows.length
      ? `- **CI-Workflows:** ${report.repo.workflows.map((w) => `\`${w}\``).join(', ')}`
      : '- **CI-Workflows:** keine'
  )
  lines.push('')

  /* ── Vorschlag ─────────────────────────────────────────────────────── */
  const rec = report.recommendation
  lines.push('## Vorschlag')
  lines.push('')
  lines.push(`Regelschärfe **${rec.level}** — ${rec.levelReason}.`)
  lines.push('')
  lines.push('```yaml')
  lines.push(renderConfigYaml(rec).trimEnd())
  lines.push('```')
  lines.push('')

  const phpComponents = rec.components.filter((comp) => ['laravel', 'php'].includes(comp.stack))
  const withBaseline = phpComponents.filter((comp) => comp.baseline)
  lines.push('### Nächste Schritte')
  lines.push('')
  lines.push(
    phpComponents.length > 0
      ? '1. `quality init` schreibt diese Konfiguration und legt fehlende phpstan.neon an.'
      : '1. `quality init` schreibt diese Konfiguration.'
  )
  if (withBaseline.length > 0) {
    lines.push('2. Baseline erzeugen, einmalig je PHP-Komponente:')
    for (const comp of withBaseline) {
      lines.push(
        `   \`\`\`bash\n   cd ${comp.path} && vendor/bin/phpstan analyse --level ${comp.phpstanLevel} --generate-baseline --memory-limit 2G\n   \`\`\``
      )
    }
    lines.push(`3. ${FORMAT_STEP}`)
    lines.push('4. CI-Vorlage aus `examples/` kopieren, erst report-only, dann als Required Check.')
  } else {
    lines.push(`2. ${FORMAT_STEP}`)
    lines.push('3. CI-Vorlage aus `examples/` kopieren, erst report-only, dann als Required Check.')
  }
  lines.push('')
  lines.push('Der Vorschlag ist eine Messung, keine Entscheidung: das Level darf höher stehen,')
  lines.push('wenn jemand die Baseline abtragen will, und niedriger, wenn das Projekt ruht.')

  return lines.join('\n') + '\n'
}
