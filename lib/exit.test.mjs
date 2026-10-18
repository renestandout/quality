/**
 * Ausgabe darf beim Beenden nicht verloren gehen.
 *
 * Der Anlass: Agents leiten die Ausgabe von quality in eine Pipe um
 * (`quality task | tail`) und bekommen das Ende nicht zu sehen. Node schreibt
 * auf macOS in eine Pipe asynchron. `process.exit()` verwirft, was dann noch
 * im Puffer liegt. Gemessen am 18.10.2026: 2 MB geschrieben, beim langsamen
 * Leser kamen 65 500 Bytes an.
 *
 * Der langsame Leser ist der Kern des Tests: ein schneller Leser leert die
 * Pipe, bevor der Puffer in Node wächst, und verdeckt den Fehler. Auf Linux
 * schreibt Node in Pipes synchron; dort ist der Test grün, auch ohne Fix.
 */
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { test } from 'node:test'

const EXIT = pathToFileURL(join(import.meta.dirname, 'exit.mjs')).href
const ZEILE = 'x'.repeat(99) + '\n'
const ZEILEN = 20000

/**
 * Startet ein Kind, das viel schreibt und mit exitAfterFlush endet. Die Pipe
 * liest ein Leser, der erst nach einer Sekunde anfängt.
 *
 * @param {'stdout' | 'stderr'} stream
 */
function langsamGelesen(stream) {
  const kind =
    `import { exitAfterFlush } from '${EXIT}'\n` +
    `const zeile = ${JSON.stringify(ZEILE)}\n` +
    `for (let i = 0; i < ${ZEILEN}; i++) process.${stream}.write(zeile)\n` +
    `process.${stream}.write('ENDE\\n')\n` +
    `exitAfterFlush(3)\n`
  const umleitung = stream === 'stderr' ? '2>&1 >/dev/null' : ''
  // pipefail reicht den Exit-Code des Kinds durch die Pipe.
  const skript = `set -o pipefail; node --input-type=module -e "$KIND" ${umleitung} | (sleep 1; cat)`
  try {
    execFileSync('bash', ['-c', skript], {
      encoding: 'utf8',
      env: { ...process.env, KIND: kind },
      maxBuffer: 64 * 1024 * 1024,
    })
    return { output: '', code: 0 }
  } catch (thrown) {
    const err = /** @type {{ stdout?: string, status?: number | null }} */ (thrown)
    return { output: err.stdout ?? '', code: err.status ?? 1 }
  }
}

for (const stream of /** @type {const} */ (['stdout', 'stderr'])) {
  test(`exitAfterFlush: ${stream} kommt beim langsamen Leser vollständig an`, () => {
    const { output, code } = langsamGelesen(stream)

    assert.equal(code, 3)
    assert.equal(output.length, ZEILEN * ZEILE.length + 'ENDE\n'.length)
    assert.ok(output.endsWith('ENDE\n'), `Ende fehlt, letzte Zeichen: ${output.slice(-20)}`)
  })
}
