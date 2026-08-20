import { spawn } from 'node:child_process'

const COLOR = process.stdout.isTTY && !process.env.NO_COLOR
const c = {
  dim: (s) => (COLOR ? `\x1b[2m${s}\x1b[0m` : s),
  red: (s) => (COLOR ? `\x1b[31m${s}\x1b[0m` : s),
  green: (s) => (COLOR ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s) => (COLOR ? `\x1b[33m${s}\x1b[0m` : s),
  bold: (s) => (COLOR ? `\x1b[1m${s}\x1b[0m` : s),
}

export { c }

/** Führt einen Schritt aus und gibt {name, code, output, skipped} zurück. */
export function runStep(step, { quiet = false } = {}) {
  return new Promise((resolvePromise) => {
    if (step.skip) {
      resolvePromise({ name: step.name, code: 0, skipped: true, reason: step.skip, output: '' })
      return
    }
    const child = spawn(step.cmd, step.args ?? [], {
      cwd: step.cwd,
      env: { ...process.env, ...(step.env ?? {}) },
      shell: false,
    })
    let output = ''
    const collect = (chunk) => {
      const text = chunk.toString()
      output += text
      if (!quiet) process.stdout.write(text)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)
    child.on('error', (err) => {
      resolvePromise({ name: step.name, note: step.note, code: 127, output: `${output}\n${err.message}`, spawnError: true })
    })
    child.on('close', (code) => {
      resolvePromise({ name: step.name, note: step.note, code: code ?? 1, output })
    })
  })
}

/** Führt Schritte nacheinander aus. stopOnFail bricht nach dem ersten Fehler ab. */
export async function runSteps(steps, { quiet = false, stopOnFail = false } = {}) {
  const results = []
  for (const step of steps) {
    if (!quiet) process.stdout.write(c.dim(`\n▸ ${step.name}\n`))
    const result = await runStep(step, { quiet })
    results.push(result)
    if (result.code !== 0 && stopOnFail) break
  }
  return results
}

/**
 * Ein Hinweis zu einem Schritt, der gelaufen ist — etwa "strict nicht
 * erzwungen". Ein Hinweis, den niemand sieht, ist kein Hinweis. Deshalb steht
 * er in der Zusammenfassung und nicht nur im Protokoll.
 */
const note = (r) => (r.note ? c.dim(` — ${r.note}`) : '')

export function summarize(results, { label }) {
  const failed = results.filter((r) => r.code !== 0)
  const skipped = results.filter((r) => r.skipped)
  const ran = results.length - skipped.length

  process.stdout.write('\n' + c.bold(`── ${label} ──`) + '\n')
  for (const r of results) {
    if (r.skipped) {
      process.stdout.write(`  ${c.dim('○')} ${r.name} ${c.dim(`— ${r.reason}`)}\n`)
    } else if (r.code === 0) {
      process.stdout.write(`  ${c.green('✓')} ${r.name}${note(r)}\n`)
    } else {
      process.stdout.write(`  ${c.red('✗')} ${r.name} ${c.dim(`(exit ${r.code})`)}${note(r)}\n`)
    }
  }
  if (failed.length === 0) {
    process.stdout.write(c.green(`\n${ran} Prüfung${ran === 1 ? '' : 'en'} bestanden.\n`))
    return 0
  }
  process.stdout.write(
    c.red(`\n${failed.length} von ${ran} Prüfungen fehlgeschlagen: ${failed.map((f) => f.name).join(', ')}\n`)
  )
  return 1
}
