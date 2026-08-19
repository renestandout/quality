# Self-hosted Runner für die Quality-Gates

Stand: 2026-08-18. Kontext: die Quality-Workflows verbrauchten 71 % der
GitHub-Actions-Minuten (Messung in
`adboard/docs/2026-08-18_github-actions-verbrauch.md`). Self-hosted Runner
kosten bei GitHub null Minuten, auch in privaten Repos. Workflows, Required
Checks und Tamper-Check bleiben unverändert — nur `runs-on` ändert sich.

## Warum die VM nicht bei AWS steht

Die erste Runner-VM war eine Lightsail-Instanz. Sie lief, aber siebenmal
langsamer als nötig — der Grund steht im nächsten Abschnitt und ist die
wichtigste Lehre dieses Setups. Seit dem 19.08.2026 läuft der Runner
deshalb bei Hetzner.

Zwei Fallen bei der Typauswahl, beide selbst erlebt:

**Preise gelten je Standort.** `cpx31` kostet in Falkenstein 17,49 EUR und
in Ashburn 62,49 EUR — dasselbe Produkt, mehr als das Dreifache. Wer den
Preis für einen Standort abfragt und am anderen bucht, zahlt drauf. Immer
`hcloud server-type describe <typ> -o json | jq '.prices[]'` lesen, nicht
nur den ersten Wert.

**Verfügbarkeit ist nicht Preisliste.** Die ARM-Typen (`cax*`) sind mit
10,49 EUR für 4 Kerne konkurrenzlos, waren aber in allen drei EU-Standorten
ausverkauft. `hcloud server-type describe <typ>` zeigt je Standort
`Available: yes|no`; die Preisliste zeigt alle Standorte unabhängig davon.
Wird ARM wieder frei, lohnt der Wechsel — dann müssen die Workflows ihre
`linux_x64`-Downloads (gitleaks, shfmt) architekturabhängig machen.

## Warum nicht Lightsail: burstbare CPU

Der Abschnitt beschreibt die verworfene erste Wahl. Er steht hier, weil der
Fehler von aussen unsichtbar ist — die Instanz lief, nichts war rot, alles
dauerte nur ein Vielfaches.

Alle Lightsail-Bundles der `*_3_0`-Familie sind **burstbar**. Sie liefern die
nominelle Leistung nur, solange Burst-Guthaben da ist; danach deckelt AWS
hart auf eine Baseline. Für `medium_3_0` sind das **20 % von 2 vCPU**, also
0,4 vCPU dauerhaft.

CI ist dafür das ungünstigste Lastprofil überhaupt: Volllast in Schüben,
minutenlang. Gemessen am 18.08.2026 mit rankscan:

| | mit Burst-Guthaben | ohne (Dauerzustand) |
|---|---|---|
| `quality` | 6:38 | 11:52 |
| `tests` (5300 Tests) | — | 33:32 |
| Lauf gesamt, seriell | — | **48 min** |

`BurstCapacityPercentage` lag danach bei 0,0005 %, `CPUUtilization`
konstant bei exakt 20,00 % — die Drosselung ist im Graphen als gerade Linie
sichtbar. Prüfen lässt sie sich jederzeit:

```bash
aws lightsail get-instance-metric-data --region eu-central-1 \
  --instance-name quality-runner --metric-name BurstCapacityPercentage \
  --period 300 --start-time <von> --end-time <bis> \
  --unit Percent --statistics Average
```

**Konsequenz:** Lightsail ist für CI die falsche Familie, und Hochstufen
hilft kaum — `xlarge_3_0` kostet 84 USD/Mt. und liefert mit 40 % Baseline
gerade 1,6 vCPU. Deshalb der Wechsel zu Hetzner: weniger Geld, ungedrosselte
Kerne.

Die Lehre gilt über AWS hinaus: Wer eine VM für CI aussucht, muss wissen, ob
ihre CPU garantiert oder burstbar ist. Steht es nicht im Datenblatt, ist es
burstbar.

## Die VM

Hetzner Cloud `quality-runner`, Falkenstein (fsn1), Ubuntu 24.04,
Typ `cpx22` — 2 vCPU / 4 GB / 80 GB, 19,49 EUR/Mt. IP **178.105.222.60**,
User `root`, Key `~/.ssh/id_ed25519`. Firewall `runner-ssh-only` lässt nur
Port 22 herein; der Runner selbst pollt GitHub über ausgehendes HTTPS und
braucht keinen offenen Port.

Verwaltung über `hcloud` (Kontext `standout-ci`). Der API-Token braucht
**Read & Write** — mit einem Lesetoken schlägt jedes Anlegen mit
„permission denied (forbidden)" fehl, während Abfragen weiter funktionieren.

Einrichtung (einmalig):

```bash
scp runner/provision.sh runner/register.sh root@<vm>:
ssh root@<vm> 'bash provision.sh'
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
| renestandout/rankscan | 1 | siehe unten — parallel ist hier langsamer |
| renestandout/adboard | 1 | zwei kurze Jobs |
| renestandout/rankscanpage | 1 | zwei kurze Jobs |
| renestandout/rankscanmautic | 1 | shellcheck + gitleaks, Sekunden |

**Eine Instanz je Repo, nicht zwei.** Der naheliegende Gedanke ist, mehrere
Runner zu registrieren, damit die Jobs eines Laufs parallel starten. Gemessen
am 18.08.2026 mit rankscan auf zwei Kernen: `quality` braucht allein 6:38 und
neben laufenden Tests über 30 Minuten — Faktor fünf, nicht Faktor zwei. Beide
Jobs sind CPU-gebunden, bremsen sich gegenseitig aus und drücken zusätzlich
in den Swap. Seriell auf der vollen Maschine ist die Gesamtzeit kürzer, jeder
Job bleibt in seinem Timeout, und die Läufe werden vorhersagbar.

Mehr Parallelität lohnt erst mit mehr Kernen als Jobs. Solange die Maschine
zwei hat, bleibt es bei einer Instanz je Repo.

## Gemessene Laufzeiten

rankscan, seriell, 19.08.2026 — dieselbe Suite auf beiden Maschinen:

| Job | Lightsail (gedrosselt) | Hetzner cpx22 |
|---|---|---|
| `quality` | 11:52 | **4:07** |
| `tests` (5300 Tests) | 33:32 | **8:19** |
| `audit` | 3:02 | **0:36** |
| gesamt | 48 min | **14:51** |

Die Timeouts in `rankscan/application` (15 / 25 / 10 Minuten) sind an diesen
Zahlen ausgerichtet: reichlich Luft für eine wachsende Suite, aber eng genug,
dass ein echter Hänger den einzigen Runner-Slot nicht stundenlang belegt.

Je Instanz, vom Arbeitsrechner aus:

```bash
TOKEN=$(gh api -X POST repos/<owner/repo>/actions/runners/registration-token -q .token)
ssh root@<vm> "RUNNER_TOKEN=$TOKEN bash register.sh <owner/repo> <nr>"
```

Das Token gilt 1 Stunde und nur für die Registrierung. Danach hält der
Runner ein eigenes, automatisch rotiertes Credential.

## Workflow umstellen

In `.github/workflows/quality.yml` je Job:

```yaml
runs-on: [self-hosted, linux]
```

**Ausnahme 1: `setup-php` muss raus.** Die Action stellt die PHP-Version per
`update-alternatives` **systemweit** um. Auf einem geteilten Host gewinnt bei
gleichzeitigen Jobs die zuletzt gesetzte Version — und zwar über
Repository-Grenzen hinweg: am 19.08.2026 lief adboards `artisan test` unter
PHP 8.3, weil rankscan/website im selben Moment einen 8.3-Job fuhr. Die
Meldung lautete „Your Composer dependencies require a PHP version >= 8.4.1"
und sah nach einem Composer-Problem aus.

Stattdessen einen job-lokalen Symlink in `$RUNNER_TEMP` (je Job eigen):

```yaml
      - name: PHP 8.4 in den PATH
        run: |
          mkdir -p "$RUNNER_TEMP/php-bin"
          ln -sf /usr/bin/php8.4 "$RUNNER_TEMP/php-bin/php"
          echo "$RUNNER_TEMP/php-bin" >> "$GITHUB_PATH"
```

Die Versionen samt Extensions liegen auf der VM (`provision.sh`). Nebeneffekt:
der Setup-Schritt entfällt, das spart je Job rund eine halbe Minute. Für einen
Rückweg auf `ubuntu-latest` muss `setup-php` wieder hinein — dort gibt es kein
`/usr/bin/php8.4`.

Dieselbe Vorsicht gilt für jede Action, die Systemzustand ändert statt nur den
Job-Workspace: auf einem Wegwerf-Runner ist das folgenlos, hier nicht.

**Ausnahme 2: Jobs mit `services:`.** Feste Host-Ports funktionieren nur,
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

**Ausnahme 3: ein gesetztes `tmpDir` in `phpstan.neon` gehört raus.** Projekte,
die auf `ubuntu-latest` liefen, haben es oft gesetzt, um den PHPStan-Cache über
`actions/cache` zu retten — auf einem Wegwerf-Runner ist der System-Temp bei
jedem Lauf leer. Hier ist er es nicht: `/tmp/phpstan` überlebt und ist ab dem
zweiten Lauf warm. Ein projektlokales `tmpDir` verhindert genau das, weil der
Arbeitsbaum je Lauf frisch ausgecheckt wird — der Cache landet dann in einem
Verzeichnis, das es vorher nicht gab.

Gemessen in rankscan/application am 19.08.2026, nachdem `tmpDir:
storage/phpstan` entfernt wurde: PHPStan 86s kalt, **6s warm**; der ganze
`quality`-Job fiel von 4:07 auf 1:01. Das war der Schritt, den die Umstellung
dort zunächst übersprungen hatte.

**Ausnahme 4: `COMPOSER_AUTH` gehoert an jeden `composer install`.** Ohne Token
erlaubt die GitHub-API 60 Anfragen pro Stunde und IP. Composer laedt dist-Archive
darueber, und auf einem Host, den mehrere Repositories teilen, ist das Limit
schnell erreicht. Der Fehler lautet dann „Could not authenticate against
github.com" und sieht nach einem Rechteproblem aus — er trifft auch oeffentliche
Pakete.

Tueckisch ist der Zeitpunkt: was im Composer-Cache des Runners liegt, braucht
keinen API-Aufruf. Auffallen kann das deshalb erst, wenn eine Abhaengigkeit in
einer NEUEN Version gezogen wird — am 19.08.2026 in allen drei Konsumenten
gleichzeitig, beim Sprung auf `standout/quality` v0.2.0.

```yaml
      - name: Abhängigkeiten (PHP)
        env:
          COMPOSER_AUTH: '{"github-oauth":{"github.com":"${{ secrets.GITHUB_TOKEN }}"}}'
        run: composer install --no-interaction --prefer-dist --no-progress
```

`secrets.GITHUB_TOKEN` genuegt: das Limit steigt damit auf 1000 Anfragen pro
Stunde. Job-lokal statt `composer config --global` — eine globale `auth.json`
waere wieder ein Eingriff in den geteilten Host, genau wie `setup-php`.

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
