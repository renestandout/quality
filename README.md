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
| `quality audit` | Bestandsaufnahme, ändert nichts | vor dem Onboarding, danach periodisch |

`fix` und `fast` beschränken sich auf Dateien, die sich gegenüber `HEAD`
unterscheiden; `--all` prüft alles, `--files a,b` gibt sie explizit vor.
Ab `task` wird nur noch geprüft, nicht mehr geschrieben — was in CI rot wird,
soll dort nicht heimlich repariert werden.

### Eine Stufe aufteilen: `--only`

`--only` sagt, was von einer Stufe übrig bleibt. Erlaubt sind die Schritte
`fmt`, `lint`, `types`, `test`, `build` — dazu `tamper` für den Nachlauf über
den Diff.

```bash
quality task --only fmt,lint,types    # der statische Teil, ohne Tests
quality full --only test,build        # der lange Teil
```

Gedacht für Repositories, deren CI Statik und Tests bewusst in **parallele
Jobs** trennt, damit ein Formatfehler nicht hinter einer langen Suite wartet.
Der Runner läuft mit `stopOnFail: false` — ein einzelner Job müsste sonst immer
alles abwarten, bevor er rot wird, und jeder grüne Lauf dauerte die Summe statt
das Maximum.

Zwei Dinge, die dabei leicht überraschen:

- **`--only` fügt nichts hinzu.** Es filtert die Schritte, die die Stufe ohnehin
  hätte. `quality fix --only test` läuft nicht, sondern meldet, dass nichts
  übrig bleibt (Exit 2) — eine Fehlbedienung soll nicht als grüner Lauf enden.
- **Ohne `tamper` in der Liste läuft der Tamper-Check nicht mit.** Das ist der
  Normalfall bei der Aufteilung: er gehört in CI als eigener Schritt mit
  `--base`, weil nur ein Pull Request einen Zielbranch hat.

Beispiel dafür in [`examples/ci-split-static-tests.yml`](examples/ci-split-static-tests.yml).

## Ein bestehendes Projekt aufnehmen

Das laufende Gate prüft immer nur Diffs. Ein gewachsenes Projekt braucht davor
eine Bestandsaufnahme — sonst rät man die Einstellungen, mit denen man startet.

```bash
quality audit                 # misst, ändert nichts, blockiert nie
quality audit --out audit.md  # zusätzlich als Datei
quality init                  # schreibt die vorgeschlagene Konfiguration
```

`audit` erkennt die Komponenten selbst und misst je Komponente: die
PHPStan-Fehlerzahl **je Level**, Typprüfung und Linter, Formatierung,
verwundbare Abhängigkeiten, vorhandene Suppressions und stillgelegte Tests.
Dazu einmal fürs ganze Repository: gitleaks über die **gesamte Git-Historie**.

Der Dependency-Audit läuft je Komponente, nicht je Repository. Das klingt nach
einem Detail, ist aber der Unterschied zwischen „`composer audit` ist grün" und
„das Frontend hatte vier offene Verwundbarkeiten" — genau so ist es bei adboard
passiert, bevor es dieses Werkzeug gab.

### Wie das Level zustande kommt

Der Audit sucht das höchste PHPStan-Level, auf dem das Projekt heute
fehlerfrei ist: erst Level 9, sonst binäre Suche. Das kostet vier bis sechs
Läufe statt zehn.

Gibt es kein fehlerfreies Level, gilt das höchste, dessen Fehlerzahl noch
unter 500 liegt — mit Baseline. Die Grenze ist bewusst da: eine Baseline mit
vierstelliger Fehlerzahl trägt niemand mehr ab, sie ist Kapitulation mit
Zwischenschritt. Ist schon Level 0 darüber, sagt der Bericht genau das.

Zusätzlich zeigt er, wie sich die Fehler verteilen. Bei adboard stecken 164
der 429 Fehler in fünf von 61 Dateien — das entscheidet, ob eine Baseline
abtragbar ist, und steht in keiner Gesamtzahl.

**Wurde nicht gemessen, steht das im Vorschlag.** Fehlt PHPStan, schlägt der
Bericht trotzdem Level 5 mit Baseline vor, markiert die Zahl aber im YAML als
`# ungemessen`. Die Empfehlung wegzulassen wäre der gefährlichere Weg: die
Konfiguration liefe dann still auf dem Standardwert ohne Baseline.

`init` schreibt nur, was der Audit gemessen hat, und überschreibt nichts von
sich aus (`--force`, `--dry-run`, `--from audit.json`).

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
npm test
```

Der Runner kommt ohne Laufzeit-Abhängigkeiten aus — bei einer
Composer-Installation liegt kein `node_modules` daneben. Deshalb auch der
eigene, bewusst eng begrenzte YAML-Leser in `lib/yaml.mjs`.
