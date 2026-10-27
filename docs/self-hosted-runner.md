# Self-hosted Runner für die Quality-Gates

Stand: 2026-08-18, VM-Angaben 2026-10-03, Bot-PRs und Wartung 2026-10-27. Kontext: die Quality-Workflows verbrauchten 71 % der
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

|                      | mit Burst-Guthaben | ohne (Dauerzustand) |
| -------------------- | ------------------ | ------------------- |
| `quality`            | 6:38               | 11:52               |
| `tests` (5300 Tests) | —                  | 33:32               |
| Lauf gesamt, seriell | —                  | **48 min**          |

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
Typ `cpx32` — 4 vCPU (AMD EPYC Genoa) / 8 GB, 35,49 EUR/Mt. IP **178.105.222.60**,
User `root`. Zugang haben zwei Keys: `~/.ssh/id_ed25519` vom MacBook und
seit dem 27.10.2026 `~/.ssh/id_ed25519` vom Mac mini (`agentmini@mini`).
Firewall `runner-ssh-only` lässt nur
Port 22 herein; der Runner selbst pollt GitHub über ausgehendes HTTPS und
braucht keinen offenen Port.

**Die Platte ist kleiner als der Typ.** Am 03.10.2026 lief das Hochstufen von
`cpx22` auf `cpx32` ohne Disk-Upgrade. Der Typ nennt 160 GB, die VM hat
weiterhin 80 GB (`primary_disk_size: 80`). Das hält den Rückweg auf `cpx22`
offen, denn eine grössere Disk lässt sich nicht mehr verkleinern. Wird der
Platz knapp, geht es nur mit einem zweiten Rescale samt Disk-Upgrade und
danach `growpart /dev/sda 1 && resize2fs /dev/sda1`.

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

**Auf der VM liegt mehr PHP, als `provision.sh` installiert.** Am 21.10.2026
lagen dort zusätzlich `php-fpm8.3/8.4`, `php-cgi8.3/8.4` und
`libphp8.3/8.4.so` für Apache. Beide FPM-Dienste liefen seit dem 19.08.2026.
Kein dpkg-Paket führt diese Dateien, und das dpkg-Log kennt ihre Installation
nicht. Build-Zeit und Version gleichen den sury-CLI-Paketen. Vermutlich hat
`setup-php` sie installiert. Belegt ist das nicht.

Kein Workflow braucht FPM, und kein Webserver läuft. Wegen CVE-2026-109618
und CVE-2026-109619 sind `php8.3-fpm` und `php8.4-fpm` seit dem 21.10.2026
gestoppt und deaktiviert (`systemctl disable --now`). Die Sicherung von
`/etc/php` liegt in `/root/backup-php-cve-20261021/etc-php.tgz`. Braucht ein
Workflow FPM doch, schalte es mit `systemctl enable --now php8.4-fpm` wieder
ein.

**PHP-Sicherheitsupdates spielst du nur ein, wenn kein Job läuft.**

```bash
ssh root@<vm> 'ps -eo cmd | grep "[R]unner\.Worker" || echo "kein Job aktiv"'
ssh root@<vm> "apt-get update && apt-get install --only-upgrade 'php8.3-*' 'php8.4-*'"
ssh root@<vm> 'php8.3 -v | head -1; php8.4 -v | head -1'
```

Am 21.10.2026 kamen PHP 8.4.27 und 8.3.36 nicht über apt. Die PPA hatte die
Builds fertig, aber noch nicht im Paketindex. Die je 12 installierten Pakete
stammen deshalb direkt aus den Launchpad-Builds 33861469 (php8.4) und
33861458 (php8.3). Ihre SHA256-Summen stimmen mit der jeweiligen
`.changes`-Datei überein. Eine Repo-Signatur prüft dieser Weg nicht, die
Herkunft sichert nur HTTPS. Pakete und Prüfsummen liegen in
`/root/php8.4.27-debs` und `/root/php8.3.36-debs`. Die Pakete `-fpm`, `-cgi`
und `libapache2-mod-php` sind bewusst nicht dabei: Ihr postinst würde FPM
wieder aktivieren. Die Dateien ausserhalb von dpkg bleiben deshalb auf
8.4.24 und 8.3.33.

Am 27.10.2026 führte die PPA 8.4.27 und 8.3.36 im Paketindex. Der nächste
Update läuft also wieder über apt, mit dem Befehl oben.

Prüfe laufende Jobs nicht mit `pgrep -f Runner.Worker`. Das Muster steht in
der eigenen Befehlszeile der SSH-Shell, und `pgrep` meldet dann immer einen
Job.

Zwei Dinge daran sind nicht offensichtlich, beide beim ersten Umzug
aufgefallen:

**Der `runner`-User bekommt passwortloses sudo.** GitHub-Hosted-Runner geben
ihrem Job-User genau das, und Actions setzen es voraus. `setup-php` legt sein
Lock-Verzeichnis per sudo an; fehlt sudo, scheitert es nicht, sondern wartet
endlos — der Job hängt bis zum Timeout, ohne eine brauchbare Fehlermeldung.
Sicherheit kostet das nichts: wer einen PR schreiben kann, führt hier ohnehin
eigenen Code aus (Tests, Build, composer-Scripts). Die Schutzgrenze ist, dass
nur private Repos ohne Fork-PRs hier laufen. Dependabot durchbricht diese
Annahme: der Bot schreibt PRs, ohne dass ein Mensch den Code gesehen hat.
Deshalb laufen Bot-PRs nicht hier, siehe „Bot-PRs nie auf dem geteilten
Runner".

**shellcheck muss mit.** Auf `ubuntu-latest` ist es vorinstalliert, der
mautic-Workflow ruft es direkt auf. Es war der eine Befehl, der sonst gefehlt
hätte — ein guter Anlass, bei neuen Repos zu prüfen, welche Werkzeuge der
Workflow als vorhanden voraussetzt.

## Runner registrieren

`renestandout` ist ein persönlicher Account. Org-Runner gibt es dort nicht —
jede Runner-Instanz gehört zu genau einem Repository. Verteilung:

| Repository                  | Instanzen | Grund                                                    |
| --------------------------- | --------- | -------------------------------------------------------- |
| renestandout/rankscan       | 2         | `tests` belegt eine Instanz rund 10 Minuten, siehe unten |
| renestandout/adboard        | 1         | zwei kurze Jobs                                          |
| renestandout/rankscanpage   | 1         | zwei kurze Jobs                                          |
| renestandout/rankscanmautic | 1         | shellcheck + gitleaks, Sekunden                          |
| renestandout/calcup         | 1         | Grund nicht dokumentiert                                 |
| renestandout/resplan        | 1         | Grund nicht dokumentiert                                 |

**Eine Instanz je Repo, ausser bei rankscan.** Der naheliegende Gedanke ist,
mehrere Runner zu registrieren, damit die Jobs eines Laufs parallel starten.
Auf cpx22 war das falsch. Gemessen am 18.08.2026 mit rankscan auf zwei Kernen: `quality` braucht allein 6:38 und
neben laufenden Tests über 30 Minuten — Faktor fünf, nicht Faktor zwei. Beide
Jobs sind CPU-gebunden, bremsen sich gegenseitig aus und drücken zusätzlich
in den Swap. Seriell auf der vollen Maschine ist die Gesamtzeit kürzer, jeder
Job bleibt in seinem Timeout, und die Läufe werden vorhersagbar.

Mehr Parallelität lohnt erst mit mehr Kernen als Jobs. Seit dem 03.10.2026
hat die Maschine vier Kerne und 8 GB, und rankscan hat zwei Instanzen. Der
Grund: `tests` lief allein rund 11 Minuten, und PHPUnit nutzt dabei nur einen
Kern. Vorher wartete der Required Check `quality` im Schnitt 8 Minuten hinter
`tests` (15 Läufe ab 12.09.2026, Spitze 15 Minuten).

Gemessen am 03.10.2026 auf cpx32, main-Lauf 37148357345 mit zwei Instanzen:

| Job          | Wartezeit | Laufzeit | vorher Ø (eine Instanz, cpx22) |
| ------------ | --------- | -------- | ------------------------------ |
| `tests`      | 0:02      | 10:07    | 11:26                          |
| `quality`    | 0:02      | 1:06     | 8:16 Wartezeit + 1:17          |
| `prod-build` | 2:11      | 0:47     | 7:28 Wartezeit + 0:50          |
| `audit`      | 4:00      | 0:23     | 10:03 Wartezeit + 0:26         |

`tests` wurde neben den anderen Jobs nicht langsamer. Auf der VM lag die Last
bei höchstens 4,8, der Speicher bei höchstens 3,4 GB, der Swap blieb leer.
Der Lauf ist nach der Dauer von `tests` fertig. Der Rückbau, falls nötig:
`./svc.sh uninstall` und `./config.sh remove` in `/opt/gh-runner/rankscan/2`.

Die anderen Repos warten im Schnitt höchstens zwei Minuten und behalten eine
Instanz. Alle Repos teilen dieselben vier Kerne.

Der grösste offene Hebel liegt in rankscan selbst: PHPUnit parallel
(`php artisan test --parallel` mit paratest). Dabei ist zu beachten, dass
`tests/bootstrap.php` nur die Datenbank `db_test` zulässt. Laravel legt im
Parallelbetrieb aber `db_test_1` bis `db_test_N` an.

## Gemessene Laufzeiten

rankscan, seriell, 19.08.2026 — dieselbe Suite auf beiden Maschinen:

| Job                  | Lightsail (gedrosselt) | Hetzner cpx22 |
| -------------------- | ---------------------- | ------------- |
| `quality`            | 11:52                  | **4:07**      |
| `tests` (5300 Tests) | 33:32                  | **8:19**      |
| `audit`              | 3:02                   | **0:36**      |
| gesamt               | 48 min                 | **14:51**     |

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
runs-on: ${{ github.event.pull_request.user.type == 'Bot' && 'ubuntu-latest' || fromJSON('["self-hosted","linux"]') }}
```

Bot-PRs laufen damit auf `ubuntu-latest`, alles andere auf der VM. Der Grund
steht unter „Bot-PRs nie auf dem geteilten Runner". Die Beispiele in
`examples/ci-split-static-tests.yml` und `examples/ci-monorepo-php-js.yml`
zeigen den vollständigen Job.

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

Bot-PRs laufen auf `ubuntu-latest`. Ein Job braucht deshalb beide Wege, und
`runner.environment` wählt den passenden:

```yaml
- uses: shivammathur/setup-php@v2
  if: runner.environment == 'github-hosted'
  with:
    php-version: '8.4'
    coverage: none

- name: PHP 8.4 in den PATH
  if: runner.environment == 'self-hosted'
  run: |
    mkdir -p "$RUNNER_TEMP/php-bin"
    ln -sf /usr/bin/php8.4 "$RUNNER_TEMP/php-bin/php"
    echo "$RUNNER_TEMP/php-bin" >> "$GITHUB_PATH"
```

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
    ports: [5432] # kein 5432:5432

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

### Bot-PRs nie auf dem geteilten Runner

**Regel:** Dependabot-PRs und andere automatisch erzeugte PRs laufen nie auf
dem geteilten Runner, sondern auf `ubuntu-latest`.

**Begründung:** Ein Bot-PR installiert neue Paketversionen, bevor ein Mensch
sie gelesen hat, und auf dem persistenten Runner mit `NOPASSWD:ALL` hätte ein
kompromittiertes Paket Root und könnte spätere Läufe aller Repos auf der VM
manipulieren.

Befund aus der Security-Prüfung von rankscan am 26.10.2026. Drei Punkte
machen den Runner zum gemeinsamen Ziel. `register.sh` registriert ohne
`--ephemeral`, Caches und Dateien bleiben also zwischen Läufen liegen.
`provision.sh` gibt dem User `runner` die Gruppe `docker` und
`NOPASSWD:ALL`. Und sechs Repos teilen die VM: rankscan, rankscanpage,
adboard, calcup, resplan und rankscanmautic. Ein manipulierter Lauf könnte
auch die Check-Ergebnisse fälschen, die rankscan für Release-Tags liest.

Die Bedingung prüft den Autor des PRs
(`github.event.pull_request.user.type == 'Bot'`), nicht `github.actor`.
`github.actor` ist, wer den Lauf ausgelöst hat. Pusht ein Mensch einen Fix
auf den Dependabot-Zweig, wäre er der actor, und der Lauf landete mit den
Paketen des Bots wieder auf der VM. Der Push auf `main` nach dem Merge läuft
auf der VM: dann hat ein Mensch den PR gelesen.

Die Regel gilt auch für Repos ohne `dependabot.yml`. Dependabot-
Sicherheitsupdates sind eine Repo-Einstellung und brauchen die Datei nicht.

**Tamper-Check:** Die Umstellung ändert `.github/workflows/quality.yml`. Der
Tamper-Check meldet das als `protected.changed` („CI-Workflow geändert"),
wenn ein Mensch den Commit schreibt. Der Commit braucht deshalb den Trailer,
den nur ein Mensch setzt:

```
Quality-Exception: Bot-PRs vom geteilten Runner auf ubuntu-latest
```

Ein Bot-Autor darf Workflows ohne Meldung ändern (`botMayChange`). Das gilt
für Versionsbumps von Actions, nicht für diese Umstellung.

### Vorschläge, nicht umgesetzt

Die Regel oben schützt vor Bot-PRs. Die Ursache bleibt: jeder Job ist auf
der VM faktisch root, und alle Repos teilen einen User. Drei Wege, sortiert
nach Aufwand:

1. **`NOPASSWD:ALL` eingrenzen.** `setup-php` braucht sudo für sein
   Lock-Verzeichnis. Der Symlink-Weg oben braucht gar kein sudo. Eine
   sudoers-Regel nur für die Befehle, die verbleibende Actions wirklich
   aufrufen, nimmt Root weg. Offen: welche Befehle das sind. Das zeigt erst
   ein Lauf mit `sudo`-Protokoll. Die Gruppe `docker` bleibt dabei faktisch
   root, solange Jobs `services:` nutzen.
2. **Ein Unix-User je Repo.** Je Repo eine Runner-Instanz unter eigenem User
   mit eigenem Home. Caches und Workspaces sind dann getrennt. Hilft nur
   zusammen mit Punkt 1, sonst ist jeder User wieder root.
3. **Ephemere Runner.** `--ephemeral` beendet die Instanz nach einem Job.
   Erst mit einer frischen VM oder einem frischen Container je Job ist das
   eine Schutzgrenze. Der Preis: der warme PHPStan-Cache und die
   composer-/npm-Caches fallen weg, und es braucht einen Dienst, der Runner
   nachregistriert.

Empfehlung: Punkt 1 zuerst, er ist klein und nimmt den grössten Hebel weg.
Danach Punkt 2. Punkt 3 erst, wenn ein Repo public wird.

**Ausfall heisst hängend, nicht rot.** Fällt die VM aus, warten Checks
endlos statt zu scheitern. Überwachung je Repo:

```bash
gh api repos/<owner/repo>/actions/runners -q '.runners[].status'
```

**Fallback:** ein Einzeiler-Commit zurück auf `runs-on: ubuntu-latest`.
Das Freikontingent (2'000 min/Mt.) trägt den Übergang.

**Wartung:** Stand 27.10.2026, alles legt `provision.sh` an.

| Was                         | Wie                                                   |
| --------------------------- | ----------------------------------------------------- |
| Runner                      | aktualisiert sich selbst                              |
| Ubuntu noble, -security     | unattended-upgrades, Vorgabe von Ubuntu               |
| Ubuntu noble-updates        | unattended-upgrades, `52unattended-upgrades-local`    |
| Kernel-Neustart             | automatisch um 03:00, wenn ein Update ihn verlangt    |
| Docker, gh, pgdg            | von Hand, wenn kein Job läuft                         |
| PHP aus der PPA ondrej/php  | von Hand, wenn kein Job läuft, Befehle unter „Die VM" |
| Docker-Images und -Volumes  | `/etc/cron.daily/docker-prune`                        |
| verwaiste Service-Container | `/etc/cron.hourly/runner-stale-containers`            |

Die Ubuntu-Vorgabe von unattended-upgrades installiert nur das Release- und
das Security-Pocket und startet nie neu. Am 27.10.2026 wartete ein
Kernel-Update seit dem 15.10. auf den Neustart, und 47 Pakete aus
noble-updates lagen offen. Deshalb ergänzt `provision.sh` die Datei
`/etc/apt/apt.conf.d/52unattended-upgrades-local`. Die Datei
`50unattended-upgrades` bleibt unverändert, ein Paket-Update überschreibt
sonst die Anpassung.

Der Neustart um 03:00 bricht einen Job ab, der gerade läuft. Das ist der
Preis dafür, dass niemand an den Neustart denken muss. Die Runner-Dienste
sind `enabled` und melden sich danach von selbst bei GitHub zurück.

Den Stand prüfst du so:

```bash
ssh root@<vm> 'uptime; ls /var/run/reboot-required 2>/dev/null; apt list --upgradable 2>/dev/null | wc -l; df -h /; docker system df'
```

**Docker und gh von Hand aktualisieren.** Ein Neustart von Docker beendet
laufende `services:`-Container. Der Befehl wartet deshalb, bis kein Job
läuft. Danach stoppt er die Runner, damit zwischen Prüfung und Neustart
kein Job startet. Wartende Jobs bleiben bei GitHub in der Warteschlange.

```bash
ssh root@<vm> 'while ps -eo cmd | grep -q "[R]unner\.Worker"; do echo "Job aktiv, warte"; sleep 30; done; systemctl stop "actions.runner.*"; DEBIAN_FRONTEND=noninteractive apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --only-upgrade docker-ce docker-ce-cli docker-ce-rootless-extras containerd.io docker-buildx-plugin docker-compose-plugin gh; systemctl start $(systemctl list-unit-files "actions.runner.*" --no-legend | awk "{print \$1}"); docker version --format "{{.Server.Version}}"'
```

Prüfe danach `systemctl is-active docker`, die 7 Runner-Dienste und den
Status bei GitHub (`gh api repos/renestandout/<repo>/actions/runners`). Nur
rankscan nutzt einen `services:`-Container (`postgres:17`). Ein grüner
rankscan-Lauf auf der VM bestätigt deshalb das Update. Nimm dafür einen
Push auf `main`, keinen Bot-PR. Bot-PRs laufen auf `ubuntu-latest` und
prüfen die VM nicht.

Letztes Update am 27.10.2026: Docker 29.7.2 → 29.9.2, containerd 2.3.3 →
2.4.2, runc 1.4.3 → 1.5.2, buildx 0.36.1 → 0.38.1, compose 5.5.0 → 5.6.1,
gh 2.97.0 → 2.103.3. Die Release Notes nannten keine Änderung, die
`services:`-Container oder Runner betrifft. Die entfernten Optionen von
containerd 2.4 gehören zu CRI, und CRI ist auf der VM abgeschaltet.

**Anonyme Volumes wachsen still.** `docker system prune` löscht keine Volumes.
Jeder `services:`-Container hinterlässt aber eines. Am 03.10.2026 lagen 634
davon mit 29 GB auf der 80-GB-Platte. Seither ruft der Cron zusätzlich
`docker volume prune -f` auf. Prüfen lässt sich der Stand mit
`docker system df`.

Wöchentlich reichte das Ende Oktober nicht mehr. Ein Volume belegt bis
220 MB. Am 26.10.2026 kamen 102 Volumes mit 10,8 GB dazu, am 27.10. lagen
208 Volumes mit 23 GB auf der Platte und nur noch 18 GB waren frei. Seit dem
27.10.2026 läuft der Cron deshalb täglich. Die Images behalten ihre 7 Tage,
damit der Cache warm bleibt.
