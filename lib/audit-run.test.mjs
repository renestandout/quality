import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runAudit } from './audit-run.mjs'

test('phpstan: eine zu neue PHP-Version bricht die Messung mit Grund ab', async () => {
  // PHPStan 1.12 kennt PHP 8.5 nicht und lehnt phpVersion: 80500 ab.
  // Gefunden beim Audit von phpVersion null, 12.10.2026.
  const root = mkdtempSync(join(tmpdir(), 'quality-audit-run-'))
  try {
    // Ohne Commit meldet die Git-Abfrage des Audits Fehler auf stderr.
    const git = ['-c', 'user.name=test', '-c', 'user.email=test@example.com']
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', [...git, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root })
    writeFileSync(join(root, 'composer.json'), JSON.stringify({ require: { php: '^8.5' } }))
    mkdirSync(join(root, 'src'))
    writeFileSync(join(root, 'src', 'A.php'), '<?php\n')
    mkdirSync(join(root, 'vendor', 'bin'), { recursive: true })
    const calls = join(root, 'calls.log')
    const fake = join(root, 'vendor', 'bin', 'phpstan')
    writeFileSync(
      fake,
      [
        '#!/bin/sh',
        `echo run >> '${calls}'`,
        'echo "Invalid configuration:" >&2',
        `echo "The item 'parameters › phpVersion' expects to be 70100..80499|null, 80500 given." >&2`,
        'exit 1',
      ].join('\n') + '\n',
    )
    chmodSync(fake, 0o755)

    const report = await runAudit(root, { quiet: true, secrets: false })
    const phpstan = report.components[0]?.phpstan

    assert.equal(phpstan?.available, false)
    assert.match(phpstan?.hint ?? '', /8\.5/)
    assert.match(phpstan?.hint ?? '', /8\.4/)
    assert.equal(readFileSync(calls, 'utf8').trim().split('\n').length, 1, 'nur ein Lauf')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
