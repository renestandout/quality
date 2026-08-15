import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

/** Liest das Hook-JSON von stdin. Ungültige Eingabe ist kein Grund, den Agenten aufzuhalten. */
export async function readHookInput() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8').trim()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

/** Sucht die quality.yml ab einem Startverzeichnis aufwärts. */
export function findProjectRoot(startDir) {
  let dir = resolve(startDir)
  for (;;) {
    if (existsSync(join(dir, 'quality.yml')) || existsSync(join(dir, 'quality.yaml'))) return dir
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Führt den Runner aus und gibt {code, output} zurück.
 * Der Runner liegt im Plugin selbst — so ist er auch dann da, wenn das
 * Projekt das Paket (noch) nicht installiert hat.
 */
export function runQuality(args, { cwd, timeoutMs }) {
  const runner = resolve(import.meta.dirname, '..', '..', 'bin', 'quality')
  try {
    const output = execFileSync(process.execPath, [runner, ...args], {
      cwd,
      encoding: 'utf8',
      timeout: timeoutMs,
      env: { ...process.env, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    return { code: 0, output }
  } catch (err) {
    if (err.code === 'ETIMEDOUT') return { code: 0, output: '', timedOut: true }
    return { code: err.status ?? 1, output: `${err.stdout ?? ''}${err.stderr ?? ''}` }
  }
}

export function relativeToRoot(filePath, root) {
  const rel = relative(root, resolve(filePath))
  return rel.startsWith('..') ? null : rel
}
