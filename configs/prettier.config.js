/**
 * Startwert für neue Projekte — keine Vorgabe für bestehende.
 *
 * Der Bestand ist uneinheitlich (adboard: ohne Semikolons, einfache Quotes;
 * resplan: mit Semikolons, doppelte Quotes). Eine projektübergreifende
 * Vereinheitlichung würde in einem der beiden einen Diff über die halbe
 * Codebasis erzeugen, ohne dass irgendjemand etwas davon hätte. Was zählt,
 * ist Konsistenz INNERHALB eines Projekts — und dass sie automatisch entsteht.
 *
 * Bestehende Projekte übernehmen diese Datei deshalb als Ausgangspunkt und
 * passen sie VOR dem einmaligen Formatierungs-Commit an ihren Stil an.
 */
export default {
  semi: false,
  singleQuote: true,
  printWidth: 100,
  trailingComma: 'all',
  arrowParens: 'always',
}
