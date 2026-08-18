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
Workflow-Extensions, composer, den unprivilegierten User `runner`.
Node installiert `actions/setup-node` je Lauf selbst (respektiert `.nvmrc`).

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
