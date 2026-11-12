import { existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Selbstheilung des gemeinsamen PHPStan-Caches.
 *
 * PHPStan legt seinen Cache standardmässig in `sys_get_temp_dir()/phpstan` ab
 * (siehe configs/phpstan/base.neon, warum quality kein tmpDir setzt). Alle
 * Checkouts eines Projekts teilen sich also einen Cache. Der Reflection-Cache
 * darin speichert absolute Pfade, sein Schlüssel enthält den Pfad aber nicht.
 * Löscht das Board einen Worktree, verweisen Einträge auf Dateien, die es
 * nicht mehr gibt. PHPStan bricht dann in jedem anderen Checkout mit
 * «Internal error: "<pfad>" is not a file» ab. Gesehen in adboard am
 * 12.11.2026 mit PHPStan 2.3.4.
 *
 * Abhilfe: den Reflection-Cache löschen und PHPStan einmal neu starten. Der
 * erste Lauf danach ist kalt, alle weiteren sind wieder warm.
 */

/**
 * Die Meldung im JSON (`\"` im Kurzformat von laravel/pao) und in der Tabelle.
 * Die Tabelle bricht den Pfad um; der Aufrufer fügt die Zeilen vorher zusammen.
 */
const NOT_A_FILE = /Internal error:\s*\\?"([^"\\]+)\\?"\s*is not a file/

/** Hinweis für die Ausgabe, wenn quality den Cache gelöscht hat. */
export const STALE_CACHE_NOTE =
  'PHPStan-Cache verwies auf einen gelöschten Worktree. quality hat den Cache gelöscht und startet PHPStan neu.'

/**
 * Der Pfad aus der Meldung, wenn es ihn nicht mehr gibt. Sonst null.
 *
 * Bei einem Pfad in einem Phar zählt das Phar selbst: der Teil dahinter ist
 * kein Dateipfad.
 *
 * @param {string} output Ausgabe von PHPStan, stdout und stderr
 * @returns {string | null}
 */
export function stalePath(output) {
  const flat = output.replace(/[ \t]*\r?\n[ \t]*/g, '')
  const hit = NOT_A_FILE.exec(flat)
  if (!hit) return null
  const path = /** @type {string} */ (hit[1]).replace(/^phar:\/\//, '')
  const phar = path.indexOf('.phar/')
  const file = phar === -1 ? path : path.slice(0, phar + '.phar'.length)
  return existsSync(file) ? null : file
}

/** Der Reflection-Cache im Standard-tmpDir von PHPStan. */
export function reflectionCacheDir() {
  // Node und PHP lesen beide TMPDIR; ohne die Variable nehmen beide den
  // Standard des Systems.
  return join(tmpdir(), 'phpstan', 'cache', 'PHPStan')
}

/**
 * Löscht den Reflection-Cache, wenn die Ausgabe einen verwaisten Pfad nennt.
 *
 * Gibt true zurück, wenn gelöscht wurde. Dann lohnt sich ein neuer Lauf.
 *
 * @param {string} output
 * @param {{ dir?: string }} [options]
 * @returns {boolean}
 */
export function healStaleCache(output, { dir = reflectionCacheDir() } = {}) {
  if (!stalePath(output) || !existsSync(dir)) return false
  rmSync(dir, { recursive: true, force: true })
  return true
}
