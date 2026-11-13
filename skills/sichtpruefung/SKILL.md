---
name: sichtpruefung
description: Use when a web page or local HTML file must be checked visually without the personal Chrome or the Chrome extension — measures horizontal overflow per width and color scheme (light/dark) headless and saves full-page PNGs. Trigger: "Sichtprüfung", "headless prüfen", "Screenshot der Seite", "läuft etwas über", "Überlauf auf 320 px", "Dunkelmodus prüfen", "Dashboard ansehen ohne Chrome", "list_connected_browsers ist leer".
---

# Sichtprüfung headless

Das Skript `sichtpruefung.mjs` prüft eine Seite in einem eigenen Chrome-Prozess.
Der Prozess läuft headless mit einem leeren Wegwerf-Profil.
Danach beendet das Skript Chrome und löscht das Profil.
Es braucht kein npm-Paket, nur Node ab Version 22 und Google Chrome.

## Grenzen

- Starte nie das persönliche Chrome und nutze nie dessen Profilordner.
- Der Skill rendert keine Templates. Das Projekt übergibt eine fertige HTML-Datei oder eine URL.
- Seiten hinter einem Login sieht das Wegwerf-Profil nicht.

## Aufruf

Der Basisordner des Skills steht beim Laden oben im Skill-Text.

```bash
node <basisordner>/sichtpruefung.mjs <url|datei> \
  [--breiten 1100,320] [--schemata hell,dunkel] \
  [--selektor .flaeche] [--selektor .tabelle] [--aus <ordner>]
```

- `<url|datei>`: eine URL (`https://…`, `http://localhost:…`) oder ein Pfad zu einer HTML-Datei.
- `--breiten`: Breiten in px, mit Komma getrennt. Standard: `1100,320`.
- `--schemata`: `hell`, `dunkel` oder beide. Standard: beide.
- `--selektor`: CSS-Selektor, dessen Elemente auf Überlauf geprüft werden. Wiederholbar.
- `--aus`: Ausgabeordner. Ohne Angabe legt das Skript `$TMPDIR/sichtpruefung-<zeit>` an.
- `SICHTPRUEFUNG_CHROME`: setzt einen anderen Chrome-Pfad.

Das Skript prüft immer, ob die ganze Seite überläuft.
Die Selektoren kommen nur dazu.

## Ausgabe

Im Ausgabeordner liegen `befund.json` und je Variante ein PNG `<breite>-<schema>.png`.
Den Befund schreibt das Skript zusätzlich auf stdout.

```json
{
  "ziel": "file:///…/dashboard.html",
  "erstellt": "2026-11-13T14:00:00.000Z",
  "varianten": [
    {
      "breite": 320,
      "schema": "hell",
      "seiteUeberlaeuft": false,
      "seite": { "scrollWidth": 320, "clientWidth": 320 },
      "elemente": [{ "selektor": ".flaeche", "index": 0, "scrollWidth": 600, "clientWidth": 304 }],
      "png": "/…/320-hell.png"
    }
  ]
}
```

Ein Element steht nur in `elemente`, wenn `scrollWidth > clientWidth` gilt.
`index` zählt die Treffer des Selektors ab 0 in Dokumentreihenfolge.

## Exit-Code

- `0`: keine Variante überläuft.
- `1`: mindestens eine Variante überläuft. Ein Gate kann darauf abbrechen.
- `2`: Fehler, etwa Chrome fehlt, Seite lädt nicht oder Selektor ist ungültig. Die Meldung steht auf stderr.

## PNGs zeigen

1. Lies jedes PNG mit dem Read-Tool. So siehst du das Bild selbst.
2. Beschreibe René den Befund: welche Variante, welches Element, um wie viel px.
3. Schick René die PNGs mit SendUserFile, wenn das Tool in der Session verfügbar ist.
4. Fehlt SendUserFile, nenne René die absoluten Pfade der PNGs.

Ein ganzseitiges PNG ist so breit wie der Inhalt.
Eine überlaufende Seite erscheint darum breiter als die gewählte Breite.
