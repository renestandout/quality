# quality

Gemeinsame Code-Quality-Werkzeuge für Standout-Projekte. Ein Repo, vier Rollen:
Composer-Paket, npm-Paket, Quelle der CI-Bausteine und — später — Claude-Code-Plugin.

Das Ziel ist, dass ein Projekt möglichst wenig eigene Quality-Konfiguration
enthält: idealerweise eine `quality.yml` mit fünf bis zehn Zeilen.

## Einbinden

PHP-Projekt (ohne Packagist, direkt aus Git):

```bash
composer config repositories.quality vcs https://github.com/standout-gmbh/quality
composer require --dev standout/quality
composer require --dev larastan/larastan laravel/pint   # Werkzeuge des laravel-Stacks
```

JS/TS-Projekt:

```bash
npm install -D standout-gmbh/quality prettier
```

## Konfiguration

Eine `quality.yml` in der Repo-Wurzel beschreibt, woraus das Projekt besteht:

```yaml
version: 1
level: strict          # standard | strict — steuert die Regelschärfe
baseline: true         # Bestandsfehler eingefroren, geprüft wird neuer Code
components:
  - path: ads-cockpit/backend
    stack: laravel
    php: "8.3"
    phpstan_level: 5   # steigt per Ratchet; NICHT vom Profil abgeleitet
  - path: ads-cockpit/frontend
    stack: react-ts
```

Bekannte Stacks: `laravel`, `php`, `react-ts`, `next-ts`, `node-ts`.

Das PHPStan-Level steht bewusst bei der Komponente und nicht im Profil. Würde
`strict` fix Level 8 bedeuten, startete ein gewachsenes Projekt mit vierstelligen
Baselines — eine Zahl, die niemand mehr abträgt. Das Profil bestimmt die
Schärfe der Regeln, das Level den heute erreichten Stand.

## Stufen

| Befehl | Prüft | Wann |
|---|---|---|
| `quality fix` | Formatierung + Linter auf geänderte Dateien | Editor-Hook nach jedem Edit |
| `quality fast` | zusätzlich Typprüfung | Task-Abschluss, pre-commit (Ziel: < 30 s) |
| `quality task` | alles ausser Build, inklusive Tests; ändert nichts am Code | vor dem Commit |
| `quality full` | zusätzlich Build | CI |

`fix` und `fast` beschränken sich auf Dateien, die sich gegenüber `HEAD`
unterscheiden; `--all` prüft alles, `--files a,b` gibt sie explizit vor.
Ab `task` wird nur noch geprüft, nicht mehr geschrieben — was in CI rot wird,
soll dort nicht heimlich repariert werden.

## Tamper-Check

`quality tamper` sucht im Diff nach Handgriffen, die ein Gate *umgehen* statt
es zu erfüllen. Das ist der Teil, der speziell für agentische Entwicklung
existiert: lokale Hooks lassen sich umgehen, dieser Check läuft in CI über den
fertigen Diff.

Er meldet neu hinzugefügte Suppressions (`@ts-ignore`, `@phpstan-ignore`,
`eslint-disable` …), stillgelegte oder auf `.only` verengte Tests, gelöschte
Testdateien, Änderungen an Baselines, Gate- und CI-Konfiguration sowie
Lockfile-Änderungen. Test-Muster werden nur in Testdateien gesucht — eine
Funktion namens `skip()` im Produktivcode ist gewöhnlicher Code.

Lokal (`quality tamper`) wird der uncommittete Stand geprüft, inklusive noch
nicht erfasster Dateien. In CI vergleicht `--base origin/main` gegen den
Zielbranch.

Jeder Treffer lässt sich mit einem Commit-Trailer durchwinken:

```
Quality-Exception: Test hängt an einem externen Dienst, Ticket #123
```

Die Treffer verschwinden dadurch nicht aus der Ausgabe — sie blockieren nur
nicht mehr.

**Die Grenze ehrlich benannt:** Ein Agent kann diesen Trailer selbst setzen.
Der Mechanismus macht Umgehung nicht unmöglich, sondern *unübersehbar* — sie
steht dann als Begründung in der Commit-Historie statt still im Code. Das ist
der eigentliche Unterschied zu einem beiläufigen `@ts-ignore`. Die Regel, dass
der Trailer Menschen vorbehalten ist, gehört ins Agent-Regelwerk.

## Claude-Code-Plugin

Dasselbe Repo ist ein Claude-Code-Plugin. Es installiert drei Hooks und einen
Skill, der den Arbeitsablauf und die Grenzen beschreibt.

```
/plugin marketplace add renestandout/quality
/plugin install quality@standout
```

| Hook | Wann | Was |
|---|---|---|
| PreToolUse | vor Edit/Write | verweigert Schreibzugriff auf Baselines, Gate- und Linter-Konfiguration, CI-Workflows |
| PostToolUse | nach jedem Edit | formatiert und lintet **die eine** geänderte Datei, meldet Fundstellen zurück |
| Stop | vor Task-Abschluss | führt `quality fast` aus und blockiert, solange etwas rot ist |

Drei Eigenschaften sind dabei wichtiger als die Hooks selbst:

**Ohne `quality.yml` passiert nichts.** In Projekten ohne Gate beenden sich
alle drei Hooks sofort mit 0. Das Plugin darf global installiert sein, ohne
irgendwo im Weg zu stehen.

**Der Stop-Hook gibt nach drei Runden auf.** Danach fordert er den Agenten auf,
dem Menschen zu berichten, statt weiterzubasteln — und lässt beim nächsten
Versuch durch. Ein Gate, das endlos blockiert, verbrennt Kontext und provoziert
genau die Umgehungen, die es verhindern soll. Ein Timeout lässt ebenfalls
durch, weist aber darauf hin, dass der Stand ungeprüft ist.

**Die Meldungen der Werkzeuge kommen vollständig beim Agenten an**, nicht nur
die Information, dass etwas rot ist. „oxlint fehlgeschlagen" kann niemand
beheben; `src/a.ts:3:9: 'x' is declared but never used` schon.

### Lokal weicher als in CI

Zwei Tamper-Regeln — geänderte Gate-Konfiguration und geänderte Lockfiles —
melden lokal nur, ohne zu blockieren. Sie beschreiben Arbeit, die vom Menschen
kommt, und lokal gibt es noch keinen Commit, in dem eine Ausnahme stehen
könnte: ein Projekt käme sonst nicht einmal durch sein eigenes Onboarding, weil
das Anlegen der `quality.yml` das Gate schliesst. In CI zählen beide Regeln
normal. Was Agentenverhalten betrifft — Suppressions, stillgelegte oder
gelöschte Tests — blockiert auch lokal.

## CI

Unter `examples/` liegen zwei Vorlagen zum Kopieren nach
`.github/workflows/quality.yml`. Sie sind bewusst dünn — die Logik steckt im
Paket, nicht im YAML, damit ein Framework-Update über `composer update` wirkt
statt über eine Workflow-Version.

Zwei Dinge sind dabei wesentlich: `fetch-depth: 0` beim Checkout, sonst fehlt
dem Tamper-Check die Vergleichsbasis; und `if: always()` bei den nachgelagerten
Schritten, damit ein PR in einer Runde alles erfährt statt in zweien.

## Was das Framework NICHT vereinheitlicht

Den **Linter im JS-Stack**: existiert ein `lint`-Skript, wird es aufgerufen.
adboard nutzt oxlint, resplan `eslint-config-next` — beides bleibt.

Den **Formatierungsstil**: `configs/prettier.config.js` ist ein Startwert für
neue Projekte. Bestehende Projekte passen ihn an ihren Stil an, bevor sie
einmalig durchformatieren. Konsistenz innerhalb eines Projekts zählt;
projektübergreifend zählt sie nicht genug, um dafür halbe Codebasen anzufassen.

## Entwicklung

```bash
node --test 'lib/*.test.mjs'
```

Der Runner kommt ohne Laufzeit-Abhängigkeiten aus — bei einer
Composer-Installation liegt kein `node_modules` daneben. Deshalb auch der
eigene, bewusst eng begrenzte YAML-Leser in `lib/yaml.mjs`.
