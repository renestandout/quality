# Skill sichtpruefung: Design

Freigegeben von René am 13.11.2026.

## Zweck

Der Skill prüft eine Webseite headless auf horizontalen Überlauf und speichert Screenshots.
Er braucht weder das persönliche Chrome noch die Chrome-Erweiterung.
Erster Nutzer sind die acht Connector-Dashboards in connector-stack.

## Ziele und Grenzen

- Ziel: eine URL oder lokale HTML-Datei je Breite und Farbschema messen.
- Ziel: ein JSON-Befund und PNGs, Exit-Code ungleich 0 bei Überlauf.
- Kein npm-Paket, kein Browser-Download.
- Nie das persönliche Chrome-Profil nutzen.
- Keine Blade-, Laravel- oder Connector-Logik im Skill.

## Ansätze

- Gewählt (René): Chrome headless über CDP, gesteuert von Node ohne Paket.
- Verworfen: Playwright als npm-Paket (Abhängigkeit, Browser-Download ~100 MB).
- Verworfen: Puppeteer (gleiche Nachteile, kein Vorteil).

## Design

- Ort: `skills/sichtpruefung/` mit `sichtpruefung.mjs`, Tests und `fixtures/`.
- Aufruf: `node sichtpruefung.mjs <url|datei> [--breiten 1100,320] [--schemata hell,dunkel] [--selektor .x]... [--aus <ordner>]`.
- Ohne `--aus` liegt die Ausgabe unter `$TMPDIR/sichtpruefung-<zeit>`.
- Chrome startet mit `--headless`, `--remote-debugging-port=0` und Wegwerf-Profil.
- Das Skript liest den Port aus `DevToolsActivePort` im Profilordner.
- Je Variante: `Emulation.setDeviceMetricsOverride`, `Emulation.setEmulatedMedia`, Messung per `Runtime.evaluate`, PNG per `Page.captureScreenshot` mit `captureBeyondViewport`.
- Ausgabe: `befund.json` im Ordner und auf stdout, PNGs als `<breite>-<schema>.png`.
- Exit-Codes: 0 kein Überlauf, 1 Überlauf, 2 Fehler.
- Chrome und Profil werden in jedem Fall weggeräumt.
- `npm test` und `tsconfig.json` erfassen das Skript.

## Hinweis

`skills/` gehört zum Plugin `quality`. Der Skill erscheint dort als `quality:sichtpruefung`.
Mit dem Symlink nach `~/.claude/skills` kann eine Session ihn doppelt sehen.
