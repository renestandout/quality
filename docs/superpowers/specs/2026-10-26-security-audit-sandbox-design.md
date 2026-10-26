# Sandbox für den security-audit-Skill

Stand: 2026-10-26. Status: Entwurf, wartet auf Renés Freigabe.

## Zweck

Der Skill `security-audit` (global unter `~/.claude/skills/security-audit`) darf
Zielcode nur in einer Sandbox ausführen. Die Vorgaben stehen in `SKILL.md`,
Abschnitte «Universal execution safety» und «Write isolation». Fehlt eine
Kontrolle, meldet der Skill jede Spur als `needs_validation`.

Der Pilotlauf auf rankscan/application endete so: 11 Spuren, alle
`needs_validation`, kein Befund bestätigt
(`~/security-audit-skill/rankscan-application/run-1/REPORT.md`). Auf macOS
fehlten Netzwerk-Namespace, cgroup-Limits und ein Werkzeug für die Übernahme von
Artefakten.

Diese Sandbox liefert alle Kontrollen. Danach kann ein Audit-Lauf Befunde lokal
bestätigen oder verwerfen.

## Ziele

- `security-audit/sandbox-run.sh` führt einen Befehl im Zielcode aus und setzt
  dabei jede Vorgabe aus «Universal execution safety» durch.
- `security-audit/promote.py` übernimmt erlaubte Dateien aus `scratch/` nach
  `artifacts/` und setzt die 11 Schritte aus «Write isolation» wörtlich um.
- Ein Abnahmetest zeigt für jede Grenze, dass sie greift. Ein Test, der die
  Grenze nicht greifen sieht, schlägt fehl.
- Ein Probelauf mit einem bestehenden rankscan-Feature-Test läuft grün durch.
- `security-audit/README.md` erklärt den Start und den Text für den Auftrag an
  den Skill.

## Nicht-Ziele

- Kein Audit-Lauf run-2 auf rankscan. Den startet René separat.
- Keine Unterstützung für Linux- oder Windows-Hosts. Ziel ist dieser Mac mit
  Colima.
- Keine Integration in den Quality-Runner (`bin/quality`) und keine Verteilung
  an Projekte.
- Keine eigenen Images. Die Sandbox nutzt nur lokal vorhandene Images.

## Anti-Ziele (Fehlschlag, auch wenn alles läuft)

- Die echte `.env` oder ein anderes Secret eines Zielrepos gelangt in den
  Container, in `scratch/` oder in `artifacts/`.
- Ein Test meldet eine Grenze als wirksam, obwohl er sie nur annimmt.
- Ein Lauf zieht Images oder Abhängigkeiten aus dem Netz.
- `promote.py` folgt einem Symlink oder kopiert eine Datei, die sich während
  der Übernahme ändert.
- `security-audit/` landet in der npm- oder Composer-Verteilung.

## Bestand auf dem Host (geprüft am 2026-10-26)

- Docker 29.5.2 über **Colima**: vmType `vz`, Mount-Typ virtiofs, arm64,
  Ubuntu 24.04, cgroup v2, 6 CPUs, 8 GB. Colima hängt nur `$HOME` ein.
- Lokale Images, alle arm64:
  - `ddev/ddev-webserver:v1.25.4-rankscan-built`: PHP 8.4, curl, `timeout`,
    Benutzer `nobody` (65534).
  - `postgres:17-rankscan-built`: Entrypoint `docker-entrypoint.sh`, läuft
    als root und wechselt per gosu.
  - `redis:8`: vorhanden. Die Annahme «kein Redis-Image» war falsch.
- hdiutil-Probe: Ein Image von 16 MB, eingehängt unter `~/security-audit-skill/`,
  ist im Container sichtbar. Das Schreiben stoppte bei 14,5 MB. Danach liess
  sich das Image nur mit `-force` aushängen.
- Pfade ausserhalb von `$HOME` (z. B. `/private/tmp`, `/Volumes`) sieht der
  Container nicht.
- rankscan/application: 979 MB, davon `vendor/` 454 MB, `node_modules/`
  348 MB, `.git/` 94 MB.
- rankscan `phpunit.xml` setzt `DB_HOST=db` ohne `force="true"`.

## Entscheidungen von René (aus dem Auftrag)

- Ort: Ordner `security-audit/` in quality. Er gehört nicht in die Verteilung.
- Postgres und Redis laufen ohne Netz. Der Test-Container teilt den
  Netz-Namespace des Postgres-Containers: nur Loopback.
- Die Umgebung kommt nur aus `--env-file` mit Dummy-Werten. `HOME`, `TMPDIR`
  und Caches zeigen auf Scratch.
- Root-Dateisystem `--read-only`. Die Quelle ist eine Wegwerf-Kopie ohne
  `.env`, eingehängt mit `:ro`.
- Einziger beschreibbarer Mount ist Scratch: ein hdiutil-Image fester Grösse.
- Limits: `--cpus`, `--memory`, `--memory-swap` gleich `--memory`,
  `--pids-limit`, `--ulimit fsize`, `timeout`.
- Härtung: `--cap-drop ALL`, `--security-opt no-new-privileges`, Benutzer ohne
  root-Rechte.
- `promote.py` öffnet relativ zu `dir_fd`, mit `O_NOFOLLOW` und `O_NONBLOCK`,
  prüft per `fstat`, setzt Grössenlimits beim Lesen durch, prüft nach dem
  Kopieren erneut, legt das Ziel mit `O_EXCL` an und nutzt eine Allowlist.
- Keine Images bauen oder ziehen ohne Rückfrage. Gezogen wird nur vor einem
  Audit-Lauf, nie während eines Laufs.

## Aufbau

```
security-audit/
  README.md              Start eines Audit-Laufs, Text für den Auftrag
  sandbox-run.sh         prepare | exec | cleanup
  promote.py             Übernahme scratch → artifacts (nur Standardbibliothek)
  env/rankscan.env       Dummy-Umgebung für rankscan (Beispiel, keine Secrets)
  tests/
    test_promote.py      Unit-Tests für promote.py, ohne Docker
    acceptance.sh        Abnahmetest der Grenzen, braucht Docker
    probe-rankscan.sh    Probelauf mit einem rankscan-Feature-Test
```

### Verzeichnisse eines Laufs

Die Struktur folgt dem Skill: `<run>/agents/<agent-id>/`.

```
~/security-audit-skill/<repo>/run-<N>/agents/<agent-id>/
  scratch.dmg      hdiutil-Image, feste Grösse (Default 512 MB)
  scratch/         Mountpunkt des Images; einziger beschreibbarer Ort
    home/ tmp/ cache/    HOME, TMPDIR, XDG_CACHE_HOME, COMPOSER_HOME
    rw/<pfad>/           beschreibbare Unterpfade der Quelle (z. B. storage)
    input/               Prüf-Eingaben des Agents (z. B. ein neuer Test)
    out/                 Ergebnisse des Zielcodes
  src/             Wegwerf-Kopie der Quelle, parent-eigen, im Container :ro
  artifacts/       parent-eigen, nie im Container
  manifest.json    Allowlist für promote.py, parent-eigen
```

**Meine Entscheidung:** Die Quellkopie liegt neben dem Image, nicht darin.
Grund: rankscan ohne `node_modules/` und `.git/` braucht rund 540 MB. Das
sprengt ein Scratch von 512 MB. Die Kopie ist im Container nur lesbar. Sie
zählt deshalb nicht zur beschreibbaren Fläche.

### Rollen

**Meine Entscheidung** (aus dem Builder-Check), passend zum Skill:

- Der Parent ruft `prepare`, `promote.py … -- exec` und `cleanup` auf.
- Der Parent schreibt `manifest.json` und wählt das env-file.
- Ein Hunter- oder Verifier-Agent schreibt nur in `scratch/input/`. Er übergibt
  dem Parent den Befehl und die gewünschten Ergebnisdateien als Text. Der
  Parent übernimmt davon nur, was er selbst für nötig hält.

### Abnahme-Nachweis als Voraussetzung

**Meine Entscheidung** (aus dem Builder-Check):

- `acceptance.sh` schreibt bei grünem Ergebnis einen Nachweis nach
  `~/security-audit-skill/.sandbox-acceptance.json`.
- Der Nachweis enthält: Datum, Versionen von Colima und Docker, Image-IDs, Hash
  von `sandbox-run.sh`.
- `exec` verweigert den Lauf, wenn der Nachweis fehlt, rot ist oder eine dieser
  Angaben nicht mehr passt.
- Grund: Nach einem Update von Colima oder Docker kann ein Limit still
  wegfallen. Der Skill verlangt dann: Zielcode nicht ausführen.

### sandbox-run.sh

Drei Unterbefehle. Der Parent ruft sie nacheinander auf.

**`prepare`**
- Argumente: Agent-Root, Ziel-Repo, Scratch-Grösse, beschreibbare Unterpfade.
- Prüft: Agent-Root liegt unter `$HOME` und ausserhalb des Ziel-Repos. Die
  Agent-ID passt auf `^[a-z0-9][a-z0-9_-]{0,63}$` und ist kein
  Windows-Gerätename.
- Legt das hdiutil-Image an und hängt es mit `-nobrowse` am Mountpunkt
  `scratch/` ein.
- Kopiert die Quelle nach `src/`. Kopiert werden nur zwei Mengen:
  - Dateien aus `git ls-files --cached --others --exclude-standard`, also
    versionierte und neue, nicht ignorierte Dateien.
  - Der Ordner `vendor/`.
  - **Meine Entscheidung** (aus dem Builder-Check): Ignorierte Dateien bleiben
    draussen. Sie können Secrets enthalten, z. B. ein Config-Cache in
    `bootstrap/cache/config.php` oder Schlüssel in `storage/`.
  - Zusätzlich gilt eine Denylist: `.env`, `.env.*`, `auth.json`, `.ddev/`,
    `*.key`, `*.pem`.
  - Symlinks bleiben Symlinks.
- Schreibt die Source-Ref nach `src.ref.json`: Commit und ob der Arbeitsstand
  uncommittete Änderungen hat.
- Bricht ab, wenn danach eine Datei aus der Denylist in `src/` liegt.
- Legt die Scratch-Unterordner an und spiegelt die Ordnerstruktur der
  beschreibbaren Unterpfade (nur Ordner, keine Dateien).

**`exec`**
- Argumente: Agent-Root, Image, env-file, Limits, Befehl.
- Startet Postgres (optional) und Redis (optional) gehärtet, siehe unten.
- Startet den Test-Container mit diesen Optionen:
  - `--network container:<pg>`; ohne Postgres `--network none`.
  - `--read-only`, `--cap-drop ALL`, `--security-opt no-new-privileges`,
    `--user 65534:65534`, `--init`.
  - `--cpus`, `--memory`, `--memory-swap` (gleich `--memory`),
    `--pids-limit`, `--ulimit fsize=<bytes>`, `--ulimit nofile`.
  - Mounts: `src/` → `/src:ro`, `scratch/` → `/scratch`, je Unterpfad
    `scratch/rw/<pfad>` → `/src/<pfad>`.
  - `--env-file <datei>`.
  - Label `security-audit.run=<id>` für das Aufräumen.
- Leere Umgebung: Im Container startet der Befehl über `env -i` mit genau den
  Schlüsseln aus dem env-file. So fallen auch die `ENV`-Werte des Images und
  `HOSTNAME` weg. **Meine Entscheidung**, denn `--env-file` allein lässt die
  Image-Umgebung stehen.
- Wall-Clock: zwei Stufen.
  - Im Container: `timeout --kill-after=5 <sek>`.
  - Auf dem Host: ein Wächter ruft nach `<sek> + 15` `docker kill`.
  - Grund: Ein `timeout` auf dem Host beendet nur den Client, nicht den
    Container.
- Gibt den Exit-Code des Befehls zurück. Am Ende entfernt `exec` alle Container
  mit dem Label, auch bei Abbruch (trap).

**`cleanup`**
- Entfernt verbliebene Container mit dem Label.
- Hängt das Image aus, bei Bedarf mit `-force`.
- Löscht `src/` und `scratch.dmg`.
- Lässt `artifacts/` stehen.

### Postgres und Redis

- `--network none` für Postgres. Redis teilt den Netz-Namespace von Postgres
  (`--network container:<pg>`).
  - **Meine Entscheidung**: Mit eigenem `--network none` wäre Redis für den
    Test-Container nicht über Loopback erreichbar.
  - Redis bleibt trotzdem ohne Netz nach aussen.
- `--read-only`. Datenverzeichnis und Socket-Ordner als `--tmpfs` mit
  Grössenlimit. Die Daten sind Wegwerf-Daten.
- `--cap-drop ALL`, `--security-opt no-new-privileges`.
- Postgres läuft direkt als Benutzer `postgres`, nicht als root. Damit entfällt
  gosu, das ohne Capabilities scheitert. Der tmpfs gehört diesem Benutzer.
- Dummy-Zugang: `POSTGRES_USER=db`, `POSTGRES_PASSWORD=db`,
  `POSTGRES_DB=db_test`.
- Limits für CPU, Speicher und PIDs, kleiner als beim Test-Container.
- `exec` wartet mit `pg_isready` im Postgres-Container, höchstens 30 Sekunden.

### Default-Limits

| Limit | Default | Option |
|---|---|---|
| CPUs | 2 | `--cpus` |
| Speicher | 1 GB | `--memory` |
| Swap | gleich Speicher | fest, nicht änderbar |
| Prozesse | 256 | `--pids` |
| Dateigrösse | 64 MB | `--fsize` |
| Scratch | 512 MB | `--scratch-size` (bei `prepare`) |
| Laufzeit | 300 s | `--timeout` |

Die Werte sind **meine Entscheidung**. Ein rankscan-Feature-Test braucht
deutlich weniger.

### promote.py

- Nur Python-Standardbibliothek. Python 3 vom Host.
- Aufruf als Wrapper um `exec`:

  ```
  promote.py --scratch <dir> --artifacts <dir> --manifest <json> -- \
    sandbox-run.sh exec ...
  ```

- Ablauf:
  1. Manifest lesen und prüfen: relative Pfade, Limit pro Datei, Limit gesamt.
  2. Verzeichnis-Deskriptoren für `scratch/` und `artifacts/` öffnen und
     halten. Python öffnet sie nicht vererbbar (`O_CLOEXEC`).
  3. `exec` als Kindprozess starten und auf sein Ende warten.
  4. Prüfen, dass kein Container mit dem Label mehr läuft. Sonst: nichts
     übernehmen.
  5. Jede Datei aus der Allowlist einzeln nach den 11 Schritten übernehmen.
  6. Ein Protokoll als JSON ausgeben: übernommen, verworfen mit Grund.
- Damit hält der Parent die Deskriptoren vor der Ausführung, wie Schritt
  «Before execution» im Skill verlangt.
- Die 11 Schritte, umgesetzt:
  1. Pfad prüfen: nicht absolut, nicht leer, kein `.` oder `..`.
  2. Elternordner einzeln mit `os.open(..., O_DIRECTORY | O_NOFOLLOW,
     dir_fd=...)` ablaufen. Nie per Pfad neu öffnen.
  3. Datei mit `O_RDONLY | O_NOFOLLOW | O_NONBLOCK` öffnen.
  4. `fstat`: regulär, `st_nlink == 1`, Grösse unter beiden Limits.
  5. Beim Lesen mitzählen und abbrechen, sobald die Grösse das Limit oder die
     geprüfte Grösse übersteigt.
  6. Genau die geprüfte Grösse kopieren. Erneut `fstat`. Abbruch bei
     geänderter Identität (`st_dev`, `st_ino`), Art, Linkzahl, Grösse oder
     `st_mtime_ns`.
  7. Zielordner vom Artifacts-Deskriptor aus ablaufen. Fehlende Ordner mit
     `mkdir(dir_fd=...)` anlegen, dann no-follow öffnen und als Ordner prüfen.
  8. Ziel mit `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW` anlegen. `fstat`:
     regulär, Linkzahl 1. Aus dem geprüften Quell-Deskriptor schreiben.
  9. Nicht-POSIX: Abbruch mit klarer Meldung. Der Host ist macOS.
  10. Kein rekursives Kopieren, kein Glob, kein Entpacken. Symlink, FIFO,
      Socket, Gerät, Ordner, Hardlink, sich ändernde Datei und Übergrösse
      werden abgelehnt.
  11. Scheitert eine Prüfung: Eintrag verwerfen, ein halb geschriebenes Ziel
      entfernen, Grund ins Protokoll. Der Exit-Code ist dann ungleich 0.

## Abnahmetest

`tests/acceptance.sh` führt jeden Fall in einer eigenen, kleinen Sandbox aus.
Jeder Fall prüft ein konkretes Signal der Grenze, nicht nur «Befehl
scheitert».

| Grenze | Versuch im Container | Erwartetes Signal |
|---|---|---|
| Netz | `curl` auf `https://example.com` und auf `1.1.1.1` | Exit ≠ 0; nur `lo` in `/proc/net/dev` |
| Loopback | Verbindung zu Postgres auf `127.0.0.1:5432` | gelingt |
| Umgebung | `env` | Schlüssel exakt gleich dem env-file |
| Quelle | Schreiben nach `/src` und `/` | `Read-only file system` |
| Prozesse | Fork-Bombe | `pids.current` erreicht das Limit; Fork scheitert |
| Speicher | Speicherfresser | Container `OOMKilled=true` oder Exit 137 mit OOM-Zähler |
| Dateigrösse | `dd` über `fsize` | `File too large` bzw. SIGXFSZ |
| Disk | Scratch vollschreiben | `No space left on device` unter der Image-Grösse |
| Laufzeit | `sleep` länger als `timeout` | Ende nach Limit plus Karenz; Exit 124 oder 137 |
| Härtung | `id`, `CapEff` in `/proc/self/status`, `NoNewPrivs` | uid 65534, CapEff 0, NoNewPrivs 1 |
| Aufräumen | nach `exec` | kein Container mit dem Label |

`tests/test_promote.py` prüft ohne Docker: Symlink (Datei und Ordner im Pfad),
Hardlink, FIFO (ohne Blockieren), Ordner, Übergrösse pro Datei und gesamt,
bestehendes Ziel, ungültige Pfade, Datei nicht in der Allowlist, und einen
Erfolgsfall. Die Änderung während des Kopierens prüft ein Test mit einem
eingeschobenen Hook zwischen Lesen und zweitem `fstat`.

## Probelauf rankscan

- Ziel: `~/projects/rankscan/application`, nur Dummy-Daten.
- Test: `tests/Feature/Middleware/EnsureUserIsAdminTest.php`.
- Beschreibbare Unterpfade: `storage`, `bootstrap/cache`.
- env-file `env/rankscan.env`: `APP_KEY` (Dummy), `DB_HOST=127.0.0.1`,
  `DB_PORT=5432`, `DB_DATABASE=db_test`, `DB_USERNAME=db`, `DB_PASSWORD=db`,
  `HOME`, `TMPDIR`, `XDG_CACHE_HOME`, `COMPOSER_HOME`, `PATH`.
- `DB_HOST`: phpunit.xml setzt den Wert ohne `force`. PHPUnit überschreibt
  eine bestehende Umgebungsvariable dann nicht. Ich erwarte deshalb: der Wert
  aus dem env-file gilt.
  - **Unsicher**: Laravel lädt Konfiguration auch aus einem Cache. Der
    Probelauf zeigt es.
  - Scheitert die Annahme, legt `prepare` eine angepasste `phpunit.xml` in
    Scratch und der Lauf nutzt `--configuration`.
- Erwartung: Der Test läuft grün. Die Ausgabe (JUnit-XML in `scratch/out/`)
  übernimmt `promote.py` nach `artifacts/`.

## Verteilung

- npm: `files` in `package.json` nennt `security-audit/` nicht. Kein Handlungsbedarf.
- Composer: Installation per VCS von GitHub. Das Dist-Archiv entsteht über
  `git archive` und beachtet `.gitattributes`.
  - Neu: `.gitattributes` mit `/security-audit export-ignore`.
  - Neu: `archive.exclude` mit `/security-audit` in `composer.json`, für
    `composer archive`.
- Nachweis im Test: `git archive HEAD | tar -t` enthält `security-audit/`
  nicht; `npm pack --dry-run` ebenfalls nicht.
- **Grenze, die bleibt:** Die Installation als Claude-Code-Plugin klont das
  ganze Repo. Dort liegt `security-audit/` mit. Die Hooks des Plugins rufen es
  nicht auf. Ein Ausschluss ist dort nach meinem Wissen nicht möglich.

## README: Was der Auftrag an den Skill enthält

Die README erklärt:

1. Vor dem Lauf: Images prüfen (`docker image inspect`). Fehlt eines, holt
   René es vor dem Lauf. Während des Laufs wird nichts gezogen.
2. Pro Agent: `prepare`, dann `promote.py ... -- sandbox-run.sh exec ...`,
   dann `cleanup`.
3. Einen Textblock für den Auftrag an den Skill:
   - Sandbox vorhanden, Pfad zu `sandbox-run.sh` und `promote.py`.
   - Erfüllte Kontrollen mit den konkreten Limits.
   - Nachweis: Datum und Ergebnis des letzten Abnahmetests.
   - Regel: Zielcode nur über diese Befehle ausführen.

## Offen: Vertrauensgrenze (Renés Entscheid)

- Colima hängt das ganze `$HOME` beschreibbar in die VM. Geprüft am
  2026-10-26: `virtiofs (rw)`, Schreibtest in `$HOME` aus der VM gelang.
- Bricht Zielcode aus dem Container in die VM aus, erreicht er `~/.ssh`, die
  echten `.env`-Dateien und die ddev-Container im selben Docker-Daemon.
- Variante A: Die Grenze ist der Container. Der Entwurf bleibt, wie er ist.
- Variante B: Ein eigenes Colima-Profil `audit` hängt nur
  `~/security-audit-skill/` ein. Die Images kommen per `docker save | docker
  load` dorthin, vor dem Lauf. Kosten: eine zweite VM, rund 3 GB Platz, mehr
  Schritte in der README.

## Unsicherheiten

- Ob `--pids-limit`, `--memory-swap`, `--ulimit fsize` und der OOM-Killer
  unter Colima greifen, ist nicht geprüft. Der Abnahmetest entscheidet.
- Schreibrechte auf virtiofs: In der Probe erschienen Dateien im Container als
  root-eigen. Ob uid 65534 dort schreiben darf, ist offen. Mögliche Lösung:
  Scratch-Ordner mit Modus 0777 anlegen. Der Abnahmetest zeigt es.
- Ob `--network container:<pg>` mit `--network none` beim Postgres-Container
  Loopback teilt, ist nicht geprüft.
- Das Aushängen brauchte in der Probe `-force`. Ich vermute virtiofs als
  Ursache.

## Dem Builder überlassen

- Optionsnamen und Ausgabeformat von `sandbox-run.sh`, solange die README sie
  beschreibt.
- Aufbau des Manifests, solange Pfade, Limit pro Datei und Limit gesamt drin
  sind.
- Wie der Host-Wächter für die Laufzeit umgesetzt ist.
