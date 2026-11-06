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

test('npm-Workspaces: der Dependency-Audit misst einmal in der Wurzel', async () => {
  // mcp-servers: das Lockfile liegt nur in der Wurzel. Je Workspace misst der
  // Audit bewusst nicht, sonst stünde derselbe Befund zehnmal im Bericht.
  // Ohne Messung in der Wurzel fiel die Zahl aber ganz weg.
  const root = mkdtempSync(join(tmpdir(), 'quality-audit-workspaces-'))
  const savedPath = process.env.PATH
  try {
    const git = ['-c', 'user.name=test', '-c', 'user.email=test@example.com']
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', [...git, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root })
    writeFileSync(join(root, 'package.json'), JSON.stringify({ workspaces: ['servers/*'] }))
    writeFileSync(join(root, 'package-lock.json'), '{}')
    mkdirSync(join(root, 'servers', 'gsc-mcp'), { recursive: true })
    writeFileSync(join(root, 'servers', 'gsc-mcp', 'package.json'), '{}')

    const bin = join(root, 'fake-bin')
    mkdirSync(bin)
    const calls = join(root, 'calls.log')
    writeFileSync(
      join(bin, 'npm'),
      [
        '#!/bin/sh',
        `echo "$(pwd -P) $*" >> '${calls}'`,
        `echo '{"metadata":{"vulnerabilities":{"high":2,"low":1}}}'`,
      ].join('\n') + '\n',
    )
    chmodSync(join(bin, 'npm'), 0o755)
    process.env.PATH = `${bin}:${savedPath}`

    const report = await runAudit(root, { quiet: true, secrets: false })

    assert.deepEqual(
      report.components.map((c) => c.path),
      ['servers/gsc-mcp'],
    )
    assert.deepEqual(
      report.repo.workspaces?.map((w) => w.path),
      ['.'],
    )
    const deps = report.repo.workspaces?.[0]?.deps
    assert.equal(deps?.available && deps.counts.high, 2)
    assert.match(report.components[0]?.deps?.hint ?? '', /Workspace `\.`.*«Repository»/)
    const audits = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes('audit'))
    assert.equal(audits.length, 1, 'genau ein Lauf')
    assert.ok(
      audits[0]?.startsWith(
        `${execFileSync('pwd', ['-P'], { cwd: root, encoding: 'utf8' }).trim()} `,
      ),
    )
  } finally {
    process.env.PATH = savedPath
    rmSync(root, { recursive: true, force: true })
  }
})

test('verschachtelter Workspace: das Lockfile seiner Wurzel wird gemessen', async () => {
  // frontend/ ist eine Workspace-Wurzel mit eigenem Lockfile, die Repo-Wurzel
  // ist keine. Vorher fiel die Messung hier still weg: "kein Lockfile".
  const root = mkdtempSync(join(tmpdir(), 'quality-audit-workspaces-'))
  const savedPath = process.env.PATH
  try {
    const git = ['-c', 'user.name=test', '-c', 'user.email=test@example.com']
    execFileSync('git', ['init', '-q'], { cwd: root })
    execFileSync('git', [...git, 'commit', '-q', '--allow-empty', '-m', 'init'], { cwd: root })
    mkdirSync(join(root, 'frontend', 'apps', 'web'), { recursive: true })
    writeFileSync(
      join(root, 'frontend', 'package.json'),
      JSON.stringify({ workspaces: ['apps/*'] }),
    )
    writeFileSync(join(root, 'frontend', 'package-lock.json'), '{}')
    writeFileSync(join(root, 'frontend', 'apps', 'web', 'package.json'), '{}')

    const bin = join(root, 'fake-bin')
    mkdirSync(bin)
    const calls = join(root, 'calls.log')
    writeFileSync(
      join(bin, 'npm'),
      [
        '#!/bin/sh',
        `echo "$(pwd -P) $*" >> '${calls}'`,
        `echo '{"metadata":{"vulnerabilities":{"critical":1}}}'`,
      ].join('\n') + '\n',
    )
    chmodSync(join(bin, 'npm'), 0o755)
    process.env.PATH = `${bin}:${savedPath}`

    const report = await runAudit(root, { quiet: true, secrets: false })

    assert.deepEqual(
      report.repo.workspaces?.map((w) => w.path),
      ['frontend'],
    )
    const deps = report.repo.workspaces?.[0]?.deps
    assert.equal(deps?.available && deps.counts.critical, 1)
    const audits = readFileSync(calls, 'utf8')
      .trim()
      .split('\n')
      .filter((line) => line.includes('audit'))
    const frontend = execFileSync('pwd', ['-P'], { cwd: join(root, 'frontend'), encoding: 'utf8' })
    assert.deepEqual(audits, [`${frontend.trim()} audit --json`])
  } finally {
    process.env.PATH = savedPath
    rmSync(root, { recursive: true, force: true })
  }
})
