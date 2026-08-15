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
