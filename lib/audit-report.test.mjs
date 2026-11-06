import assert from 'node:assert/strict'
import { test } from 'node:test'
import { renderAudit } from './audit-report.mjs'

/** @import { AuditReport } from './audit-run.mjs' */

/**
 * Ein Bericht mit einem Workspace und dem Audit der Workspace-Wurzel.
 *
 * @param {number} high
 * @returns {AuditReport}
 */
function workspaceReport(high) {
  return {
    root: '/repo',
    repo: {
      branch: 'main',
      commits: 3,
      workflows: [],
      hasQualityConfig: false,
      secrets: { available: false, hint: 'übersprungen (--no-secrets)' },
      workspaces: [
        {
          path: '.',
          deps: {
            available: true,
            tool: 'npm',
            counts: { critical: 0, high, moderate: 0, low: 0, unknown: 0, total: high },
          },
        },
      ],
    },
    components: [
      {
        path: 'servers/gsc-mcp',
        stack: 'node-ts',
        facts: {},
        hygiene: { sourceFiles: 1, testFiles: 0, rules: [], todos: 0 },
        deps: { available: false, hint: 'Teil des Workspace `.`' },
      },
    ],
    wiring: [],
    recommendation: {
      level: 'standard',
      levelReason: 'Test',
      components: [
        {
          path: 'servers/gsc-mcp',
          stack: 'node-ts',
          php: null,
          phpstanLevel: null,
          baseline: false,
          reason: null,
          note: null,
        },
      ],
    },
  }
}

test('Workspace-Wurzel: der Bericht nennt den Dependency-Audit unter Repository', () => {
  const text = renderAudit(workspaceReport(0))
  const repo = text.slice(text.indexOf('## Repository'), text.indexOf('## Vorschlag'))
  assert.match(
    repo,
    /- \*\*Abhängigkeiten \(Workspace `\.`\):\*\* keine offenen Verwundbarkeiten — gemessen mit `npm audit`/,
  )
})

test('Workspace-Wurzel: hohe Verwundbarkeiten stehen im Kopf des Berichts', () => {
  const text = renderAudit(workspaceReport(2))
  const head = text.slice(0, text.indexOf('## Komponenten'))
  assert.match(head, /Workspace `\.`.*2 Verwundbarkeit\(en\) der Stufe hoch oder kritisch/)
})
