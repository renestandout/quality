import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Findet ein Werkzeug in der Reihenfolge Komponente → Repo-Wurzel → PATH.
 * Gibt null zurück, wenn nichts gefunden wurde; der Aufrufer entscheidet, ob
 * das ein Fehler ist oder der Schritt einfach entfällt.
 */
export function findBinary(name, { dir, root, kind }) {
  const relative = kind === 'php' ? join('vendor', 'bin', name) : join('node_modules', '.bin', name)
  for (const base of [dir, root]) {
    if (!base) continue
    const candidate = join(base, relative)
    if (existsSync(candidate)) return candidate
  }
  return null
}

/** Meldung, die sagt, was fehlt und wie man es behebt. */
export function missingToolHint(name, kind) {
  const how =
    kind === 'php'
      ? `composer require --dev ${PACKAGE_FOR[name] ?? name}`
      : `npm install -D ${PACKAGE_FOR[name] ?? name}`
  return `Werkzeug "${name}" nicht gefunden. Installieren mit:  ${how}`
}

const PACKAGE_FOR = {
  pint: 'laravel/pint',
  phpstan: 'phpstan/phpstan larastan/larastan',
  prettier: 'prettier',
  oxlint: 'oxlint',
  tsc: 'typescript',
  vitest: 'vitest',
}
