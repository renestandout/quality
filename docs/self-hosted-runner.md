# Self-hosted Runner für die Quality-Gates

Stand: 2026-08-18. Kontext: die Quality-Workflows verbrauchten 71 % der
GitHub-Actions-Minuten (Messung in
`adboard/docs/2026-08-18_github-actions-verbrauch.md`). Self-hosted Runner
kosten bei GitHub null Minuten, auch in privaten Repos. Workflows, Required
Checks und Tamper-Check bleiben unverändert — nur `runs-on` ändert sich.

## Die VM

AWS Lightsail `ci-runner`, eu-central-1, Ubuntu 24.04, 4 GB RAM / 2 vCPU /
80 GB SSD (~24 USD/Mt.). Der Runner pollt GitHub über ausgehendes HTTPS.
Eingehend ist nur SSH (Port 22) offen.

Einrichtung (einmalig):

```bash
scp runner/provision.sh runner/register.sh ubuntu@<vm>:
ssh ubuntu@<vm> 'sudo ./provision.sh'
```

`provision.sh` installiert: 2 GB Swap, Docker, PHP 8.3+8.4 mit den
Workflow-Extensions, composer, shellcheck, den User `runner`.
Node installiert `actions/setup-node` je Lauf selbst (respektiert `.nvmrc`).

Zwei Dinge daran sind nicht offensichtlich, beide beim ersten Umzug
aufgefallen:

**Der `runner`-User bekommt passwortloses sudo.** GitHub-Hosted-Runner geben
ihrem Job-User genau das, und Actions setzen es voraus. `setup-php` legt sein
Lock-Verzeichnis per sudo an; fehlt sudo, scheitert es nicht, sondern wartet
endlos — der Job hängt bis zum Timeout, ohne eine brauchbare Fehlermeldung.
Sicherheit kostet das nichts: wer einen PR schreiben kann, führt hier ohnehin
eigenen Code aus (Tests, Build, composer-Scripts). Die Schutzgrenze ist, dass
nur private Repos ohne Fork-PRs hier laufen.

**shellcheck muss mit.** Auf `ubuntu-latest` ist es vorinstalliert, der
mautic-Workflow ruft es direkt auf. Es war der eine Befehl, der sonst gefehlt
hätte — ein guter Anlass, bei neuen Repos zu prüfen, welche Werkzeuge der
Workflow als vorhanden voraussetzt.

## Runner registrieren

`renestandout` ist ein persönlicher Account. Org-Runner gibt es dort nicht —
jede Runner-Instanz gehört zu genau einem Repository. Verteilung:

| Repository | Instanzen | Grund |
|---|---|---|
| renestandout/rankscan | 2 | `quality` + `tests` laufen parallel |
| renestandout/adboard | 1 | zwei kurze Jobs |
| renestandout/rankscanpage | 1 | zwei kurze Jobs |
| renestandout/rankscanmautic | 1 | shellcheck + gitleaks, Sekunden |

Je Instanz, vom Arbeitsrechner aus:

```bash
TOKEN=$(gh api -X POST repos/<owner/repo>/actions/runners/registration-token -q .token)
ssh ubuntu@<vm> "sudo RUNNER_TOKEN=$TOKEN ./register.sh <owner/repo> <nr>"
```

Das Token gilt 1 Stunde und nur für die Registrierung. Danach hält der
Runner ein eigenes, automatisch rotiertes Credential.

## Workflow umstellen

In `.github/workflows/quality.yml` je Job:

```yaml
runs-on: [self-hosted, linux]
```

**Ausnahme: Jobs mit `services:`.** Feste Host-Ports funktionieren nur,
solange der Runner-Host nach dem Lauf verschwindet. Hier bleibt er stehen:
zwei gleichzeitige Läufe streiten sich um denselben Port, und ein
abgebrochener Lauf hinterlässt einen Container, der ihn blockiert, bis ihn
jemand entfernt. Der nächste Lauf scheitert dann schon am Schritt
„Initialize containers" — mit einer Meldung, die nach einem Docker-Problem
aussieht und keins ist.

Deshalb nur den Container-Port angeben und den zugelosten Host-Port über den
`job`-Kontext holen:

```yaml
    services:
      postgres:
        image: postgres:17
        ports: [5432]          # kein 5432:5432

    steps:
      - name: Tests
        env:
          DB_PORT: ${{ job.services.postgres.ports['5432'] }}
        run: vendor/bin/quality full --only test
```

Der `job`-Kontext ist auf Job-Ebene **nicht** verfügbar — die Portvariable
gehört ins `env:` des Schritts, nicht in das des Jobs.

Sonst nichts. `shivammathur/setup-php` findet die vorinstallierten
PHP-Versionen, `actions/setup-node` nutzt den Tool-Cache der VM, und
composer-/npm-Caches bleiben zwischen Läufen liegen — die Läufe werden
schneller als auf GitHub-Hosted.

Der Umstellungs-PR ändert die CI-Konfiguration. Der Tamper-Check meldet das.
Commit-Trailer setzen:

```
Quality-Exception: CI-Umzug auf self-hosted Runner, Kostenprojekt
```

## Grenzen und Betrieb

**Nur für private Repos.** Fork-PRs führen fremden Code auf dem Runner aus.
Wird ein Repo public, MUSS das Setup neu bewertet werden (ephemere Runner
oder zurück auf GitHub-Hosted).

**Ausfall heisst hängend, nicht rot.** Fällt die VM aus, warten Checks
endlos statt zu scheitern. Überwachung je Repo:

```bash
gh api repos/<owner/repo>/actions/runners -q '.runners[].status'
```

**Fallback:** ein Einzeiler-Commit zurück auf `runs-on: ubuntu-latest`.
Das Freikontingent (2'000 min/Mt.) trägt den Übergang.

**Wartung:** der Runner aktualisiert sich selbst. Docker räumt ein
wöchentlicher Prune-Cron ab (legt `provision.sh` an). Ubuntu patcht über
unattended-upgrades.
