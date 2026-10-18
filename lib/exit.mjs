/**
 * Beendet den Prozess erst, wenn stdout und stderr alles abgegeben haben.
 *
 * `process.exit()` allein verliert Ausgabe: Node schreibt auf macOS in eine
 * Pipe asynchron, und der Exit verwirft, was noch im Puffer liegt. Wer
 * `quality task | tail` aufruft oder einen Hook über eine Pipe liest, sieht
 * dann das Ende nicht — genau die Zusammenfassung oder die Fehlermeldung.
 * Gemessen: 2 MB geschrieben, 65 500 Bytes kamen an.
 *
 * Ein leerer Write mit Callback wartet auf alle früheren Writes desselben
 * Streams, weil Node sie der Reihe nach abgibt. Der harte Exit bleibt danach
 * bestehen: ein offenes Handle soll den Runner nicht am Leben halten.
 *
 * @param {number} code
 * @returns {Promise<never>}
 */
export async function exitAfterFlush(code) {
  await Promise.all([flush(process.stdout), flush(process.stderr)])
  process.exit(code)
}

/** @param {NodeJS.WriteStream} stream */
function flush(stream) {
  return new Promise((resolve) => {
    // Ein geschlossener Leser (EPIPE) meldet sich über den Callback mit
    // Fehler. Dann ist nichts mehr zu retten, also trotzdem weiter.
    if (stream.destroyed || stream.writableEnded) resolve(undefined)
    else stream.write('', () => resolve(undefined))
  })
}
