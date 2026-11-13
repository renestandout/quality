# Sichtprüfung Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ein Node-Skript misst eine Seite headless auf Überlauf je Breite und Farbschema und speichert PNGs.

**Architecture:** `sichtpruefung.mjs` startet `Google Chrome.app` headless mit Wegwerf-Profil. Es spricht CDP über den eingebauten `WebSocket` von Node. Reine Funktionen (Argumente, Befund) sind getrennt testbar, der Browserteil läuft im Integrationstest gegen Fixtures.

**Tech Stack:** Node ≥ 20 (lokal 26), `node:test`, CDP, kein npm-Paket.

**Spec:** `docs/superpowers/specs/2026-11-13-sichtpruefung-design.md`

## Global Constraints

- Kein npm-, Composer- oder Browser-Paket.
- Chrome-Pfad: `/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`, überschreibbar mit `SICHTPRUEFUNG_CHROME`.
- Profil: `fs.mkdtemp(os.tmpdir()/sichtpruefung-profil-)`, nach dem Lauf rekursiv gelöscht.
- Standard: Breiten `[1100, 320]`, Schemata `['hell', 'dunkel']`.
- Exit-Codes: 0 kein Überlauf, 1 Überlauf, 2 Fehler.
- PNG-Name: `<breite>-<schema>.png`. Befund: `befund.json`.

## Review Focus

- Lokale Datei mit relativem Pfad → wird zu `file://`-URL aufgelöst (Test in Task 1).
- Unbekanntes Schema oder Breite ≤ 0 → Exit 2 mit Meldung (Test in Task 1).
- Selektor ohne Treffer → kein Fehler, kein Eintrag (Test in Task 2, Fixture ohne `.flaeche`).
- Chrome fehlt → Exit 2, Profilordner gelöscht (Test in Task 2 mit falschem `SICHTPRUEFUNG_CHROME`).
- Seite überläuft nur auf 320 px → Befund nennt nur diese Variante (Fixture `ueberlauf` ist auf 1100 px breit genug).

---

### Task 1: Argumente und Befund

**Files:**

- Create: `skills/sichtpruefung/sichtpruefung.mjs`
- Test: `skills/sichtpruefung/sichtpruefung.test.mjs`
- Modify: `package.json` (test-Glob um `'skills/*/*.test.mjs'`), `tsconfig.json` (include `skills/*/*.mjs`)

**Interfaces:**

- Produces: `parseArgs(argv: string[], cwd: string): {ziel: string, breiten: number[], schemata: ('hell'|'dunkel')[], selektoren: string[], aus: string|null}` — wirft `Error` bei ungültiger Eingabe.
- Produces: `hatUeberlauf(befund: {varianten: {seiteUeberlaeuft: boolean, elemente: unknown[]}[]}): boolean`.

- [ ] Test: `parseArgs(['seite.html'], '/x')` → `ziel === 'file:///x/seite.html'`, Standardwerte.
- [ ] Test: `parseArgs(['https://a.ch', '--breiten', '800', '--schemata', 'dunkel', '--selektor', '.a', '--selektor', '.b', '--aus', 'o'], '/x')` → Werte übernommen, `aus === '/x/o'`.
- [ ] Test: `--schemata grau`, `--breiten 0`, fehlendes Ziel → wirft.
- [ ] Test: `hatUeberlauf` true bei Seite oder Element, sonst false.
- [ ] Laufen lassen: FAIL. Umsetzen. Laufen lassen: PASS. Commit.

### Task 2: Messen im Browser, CLI, Fixtures

**Files:**

- Modify: `skills/sichtpruefung/sichtpruefung.mjs`
- Create: `skills/sichtpruefung/fixtures/ok.html`, `ueberlauf.html` (`.flaeche` mit `overflow:auto` und 600 px breitem Kind), `dunkel.html` (nur unter `prefers-color-scheme: dark` überläuft `body`)
- Test: `skills/sichtpruefung/sichtpruefung.test.mjs`

**Interfaces:**

- Produces: `pruefe(opt: ReturnType<typeof parseArgs> & {aus: string}): Promise<Befund>` mit `Befund = {ziel, erstellt, varianten: {breite, schema, seiteUeberlaeuft, seite: {scrollWidth, clientWidth}, elemente: {selektor, index, scrollWidth, clientWidth}[], png}[]}`.
- Produces: `main(argv): Promise<number>` liefert den Exit-Code. Seite-Überlauf misst `document.documentElement`.

- [ ] Test (je Fixture, Selektor `.flaeche`): `ok` → keine Variante überläuft. `ueberlauf` → nur 320 px meldet `.flaeche` Index 0. `dunkel` → nur Schema `dunkel` meldet `seiteUeberlaeuft`. Je Variante existiert das PNG und beginnt mit der PNG-Signatur.
- [ ] Test: `main` mit `SICHTPRUEFUNG_CHROME=/gibt/es/nicht` → 2, kein `sichtpruefung-profil-*` bleibt zurück.
- [ ] Test: `main` auf `ueberlauf.html` → 1, `befund.json` lesbar.
- [ ] Laufen lassen: FAIL. Umsetzen: spawn, Port aus `DevToolsActivePort` (Polling bis 10 s), Target über `/json/new`, CDP-Aufrufe laut Spec, `finally` beendet Chrome und löscht Profil. Laufen lassen: PASS. Commit.

### Task 3: SKILL.md und Gate

**Files:**

- Create: `skills/sichtpruefung/SKILL.md`

- [ ] SKILL.md: Frontmatter (`name: sichtpruefung`, Beschreibung mit Triggern), Aufruf, Befund-Format, Exit-Codes, PNGs zeigen per Read-Tool und SendUserFile, Grenzen (nie persönliches Chrome).
- [ ] `npm test` und `bin/quality` laufen grün. Commit.
