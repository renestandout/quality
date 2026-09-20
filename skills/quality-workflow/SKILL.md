---
name: quality-workflow
description: Use when implementing, changing or fixing code in a project that has a quality.yml — establishes the order of work (impact before change, tests before implementation, checks before completion) and the rules that must not be worked around.
---

# Arbeitsablauf in Projekten mit Quality-Gate

Dieses Projekt hat eine `quality.yml`. Damit gelten die folgenden Abläufe und
Regeln. Sie sind nicht als Empfehlung gemeint: die meisten davon werden
technisch geprüft, und der Prüfer läuft in CI, wo du ihn nicht abschalten kannst.

## Reihenfolge

**1. Vor der Änderung: Blast-Radius klären.**
Bevor du etwas änderst, beantworte für die betroffenen Symbole:

- Wer benutzt das? (`grep`, LSP-Referenzen — nicht raten)
- Sind Routen oder öffentliche API-Signaturen betroffen?
- Ändert sich das Datenbankschema? Braucht es eine Migration?
- Hängen Jobs, Queues, Events oder Commands daran?
- Ändert sich Konfiguration oder ENV?

Das Ergebnis gehört in den Plan. Es kostet zwei Minuten und erspart die
Klasse von Fehlern, die Tests nicht finden, weil niemand sie geschrieben hat.

**2. Tests zuerst oder parallel.** Nicht danach. Ein Test, der nach der
Implementierung entsteht, prüft, was der Code tut — nicht, was er soll.

**3. Implementieren.** Nach jedem Edit laufen Formatierung und Linter
automatisch. Fehler kommen als Meldung zurück; behebe sie, bevor du
weitermachst.

**4. Vor dem Task-Abschluss: `quality fast`.** Das läuft ohnehin automatisch
und blockiert den Abschluss, solange etwas rot ist. Läuft es dreimal
erfolglos, wird es durchgelassen — dann berichte dem Menschen, was rot bleibt,
statt es zu verschweigen.

**5. Vor dem Commit: `quality task --base main` und `/code-review` auf den Diff.**
Das Review läuft in einem eigenen Kontext, weil du auf deine eigene Arbeit
systematisch blind bist.

`--base main` nennt den Stand, von dem dein Zweig abzweigt. Der fmt-Schritt
blockiert dann nur für deinen eigenen Diff. Eine Formatierung, die auf `main`
längst behoben ist und die dein Zweig nur noch in der alten Fassung trägt,
erscheint als Hinweis statt als Fehler. Fasse sie nicht an: beim Merge
verschwindet sie von selbst, und eine Änderung daran erzeugt einen Konflikt.
Ohne `--base` prüft `task` die ganze Fläche hart — das ist der Normalfall
ausserhalb eines Worktrees.

## Was du nicht tust

Diese Liste ist kurz, weil jede Zeile darauf zählt. Alles hier wird vom
Tamper-Check im Diff erkannt und macht den CI-Lauf rot — im Pull Request wie
beim Push auf `main`.

- **Keine Suppressions einfügen.** Kein `@ts-ignore`, `@ts-expect-error`,
  `@phpstan-ignore`, `eslint-disable`, `oxlint-disable`. Wenn ein Prüfer
  meckert, ist der Code gemeint, nicht der Prüfer.
- **Keine Tests stilllegen, löschen oder abschwächen.** Kein `.skip`,
  `markTestSkipped`, `.only`, keine auskommentierten Testfälle, keine
  entfernten Assertions. Ein Test, der stört, hat meistens recht.
- **Keine Baseline erweitern.** `phpstan-baseline.neon` und
  `eslint-suppressions.json` frieren die Vergangenheit ein. Neue Fehler dort
  einzutragen heisst, das Problem in die Zukunft zu verschieben.
  Eine Baseline SCHRUMPFEN darfst du dagegen — und sollst du auch, siehe unten.
- **Keine Quality-Konfiguration anfassen.** `quality.yml`, `phpstan.neon`,
  Linter- und Formatter-Konfiguration, CI-Workflows und Hook-Einstellungen
  ändert der Mensch, nicht du.
- **Den Ausnahme-Trailer setzt du nie selbst.** `Quality-Exception:` ist
  ausdrücklich Menschen vorbehalten. Der Trailer existiert, damit eine bewusste
  Ausnahme sichtbar wird — wenn du ihn selbst setzt, ist er wertlos.
- **Keine Abhängigkeit ohne Auftrag.** Neue Pakete brauchen eine Begründung
  und die Zustimmung des Menschen. Prüfe zuerst, ob das Projekt das Problem
  schon löst.

## Die Baseline schrumpfen: `quality prune`

Das ist die eine Ausnahme in der Liste oben, und sie ist ausdrücklich gewollt.

Verbesserst du Code, werden Baseline-Einträge wertlos. PHPStan meldet sie dann
als `ignore.unmatched`, und der Lauf wird rot, obwohl kein echter Fehler offen
ist. Das behebst du selbst:

```bash
quality prune --dry-run   # zeigt, welche Einträge wegfallen
quality prune             # entfernt sie
```

Drei Dinge dazu:

- **Editiere die Datei nie von Hand.** Der Hook lehnt das ab, und das ist
  richtig: das Kommando fragt den Analysator, WELCHE Einträge tot sind. Du
  kannst das nicht raten.
- **Der Lauf über die Shell ist kein Umweg um den Hook**, sondern der
  vorgesehene Weg. Das Kommando kann konstruktionsbedingt nur schrumpfen.
- **Du brauchst dafür keine Ausnahme.** Der Tamper-Check bewertet eine
  Baseline-Änderung nach ihrer Richtung: entfernt sie nur, ist sie kein Fund.
  `Quality-Exception:` bleibt trotzdem Menschen vorbehalten — du brauchst es
  hier einfach nicht mehr.

Meldet das Kommando eine unerfüllte Ausnahme AUSSERHALB der Baseline, steht sie
in der `phpstan.neon`. Die fasst du nicht an; sag es dem Menschen.

## Wenn du an eine dieser Grenzen stösst

Nicht umgehen, sondern sagen. Formuliere konkret:

> Der Prüfer meldet X in Datei Y. Ich sehe zwei Wege: A behebt die Ursache und
> braucht Änderungen an Z, B wäre eine Ausnahme. Ich empfehle A. Wie möchtest
> du vorgehen?

Das ist immer besser als ein stiller Workaround — der kostet später ein
Vielfaches, weil niemand mehr weiss, dass er da ist.

## Befehle

| Befehl | Wann |
|---|---|
| `quality fix` | läuft automatisch nach jedem Edit |
| `quality fast` | vor Task-Abschluss (läuft automatisch) |
| `quality task --base main` | vor dem Commit, inklusive Tests; `--base` im Worktree |
| `quality tamper` | zeigt, was am aktuellen Stand ein Gate umgehen würde |
| `quality prune` | entfernt tote Einträge aus der PHPStan-Baseline (`--dry-run` zeigt nur) |
