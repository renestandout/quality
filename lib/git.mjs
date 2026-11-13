/**
 * Der eine Weg, git in einem Verzeichnis aufzurufen.
 *
 * deploy-check, release und der Stop-Hook hatten je eine eigene Kopie dieser
 * Funktion. Eine Änderung an Optionen wie stdio musste so an drei Stellen
 * passieren.
 */
import { execFileSync } from 'node:child_process'

/**
 * Führt git in `root` aus und gibt die gekürzte Ausgabe zurück.
 *
 * Wirft bei einem Exit-Code ungleich 0. Der Fehler trägt die Meldung von git
 * in `stderr`. stdin ist zu, damit git nie auf eine Eingabe wartet.
 *
 * @param {string[]} args
 * @param {string} root
 * @returns {string}
 */
export function gitIn(args, root) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim()
}
