/**
 * Ordnet geänderte Dateien den Komponenten und den einzelnen Werkzeugen zu.
 *
 * Der Unterschied zwischen beidem ist nicht kosmetisch: Prettier formatiert
 * JSON, CSS und Markdown, ein Linter kennt nur Skriptdateien. Gibt man oxlint
 * eine package.json, meldet es "No files found to lint" und beendet mit 1 —
 * jede Änderung an einer Konfigurationsdatei hätte damit das Gate blockiert.
 */
import { relative } from 'node:path'

const SCRIPTS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']

export const EXTENSIONS = {
  php: { all: ['.php'] },
  js: {
    all: [...SCRIPTS, '.css', '.scss', '.json', '.md', '.yml', '.yaml'],
    lint: SCRIPTS,
    types: SCRIPTS,
    test: SCRIPTS,
  },
  // .pyi gehoert dazu: ruff formatiert und prueft Stub-Dateien, mypy liest
  // sie als Typquelle. Ohne sie bliebe eine geaenderte Signatur ungeprueft.
  py: { all: ['.py', '.pyi'] },
}

/** Dateien dieser Komponente, relativ zu ihrem Verzeichnis. */
export function filesForComponent(component, files, root) {
  const base = component.path === '.' ? '' : `${component.path.replace(/\/+$/, '')}/`
  const allowed = EXTENSIONS[component.kind]?.all ?? []
  return files
    .map((f) => (f.startsWith(root) ? relative(root, f) : f))
    .filter((f) => (base === '' ? true : f.startsWith(base)))
    .filter((f) => allowed.some((ext) => f.endsWith(ext)))
    .map((f) => (base === '' ? f : f.slice(base.length)))
}

/** Schränkt die Dateiliste auf das ein, was dieses Werkzeug verarbeiten kann. */
export function filesForVerb(kind, verb, files) {
  if (!files) return null
  const allowed = EXTENSIONS[kind]?.[verb]
  return allowed ? files.filter((f) => allowed.some((ext) => f.endsWith(ext))) : files
}
