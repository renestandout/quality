import reactTs from './react-ts.mjs'

// Next.js verhält sich für die Prüfungen wie jeder andere TypeScript-Stack;
// den Framework-Linter bringt das Projekt über sein eigenes lint-Skript mit.
export default { ...reactTs, name: 'next-ts' }
