# Sandbox für den security-audit-Skill

Der Skill `security-audit` (`~/.claude/skills/security-audit`) darf Zielcode
nur in einer Sandbox ausführen. Die Vorgaben stehen in seiner `SKILL.md`,
Abschnitte «Universal execution safety» und «Write isolation». Fehlt eine
Kontrolle, meldet der Skill jede Spur als `needs_validation`.

Dieser Ordner liefert die Sandbox für diesen Mac:

- `sandbox-run.sh` bereitet einen Lauf vor, führt ihn aus und räumt auf.
- `promote.py` übernimmt erlaubte Ergebnisdateien aus `scratch/` nach
  `artifacts/`.
- `tests/acceptance.sh` beweist jede Grenze und schreibt einen Nachweis.
  Ohne gültigen Nachweis startet `sandbox-run.sh exec` keinen Lauf.

Der Ordner gehört nicht in die Paket-Verteilung (`.gitattributes`,
`archive.exclude` in `composer.json`). Nur der Audit-Host braucht ihn.

Design: `docs/superpowers/specs/2026-10-26-security-audit-sandbox-design.md`.

## Vertrauensgrenze

Die Sandbox läuft im eigenen Colima-Profil `audit`. Diese VM hängt nur
`~/security-audit-skill/` ein. Sie sieht weder `~/.ssh` noch die `.env`-Dateien
der Projekte noch die ddev-Container im Profil `default`.

`sandbox-run.sh` nutzt immer `docker --context colima-audit`. Hängt die VM mehr
oder anderes ein, verweigert `exec` den Lauf.

## Einmalige Einrichtung

1. Profil anlegen:

   ```
   colima start -p audit --cpu 4 --memory 4 --disk 40 --vm-type vz \
     --mount-type virtiofs --mount ~/security-audit-skill:w
   ```

2. Docker-Kontext zurücksetzen. Colima stellt ihn beim Start auf
   `colima-audit` um, das würde ddev treffen:

   ```
   docker context use colima
   ```

## Vor jedem Audit-Lauf

1. VM starten: `colima start -p audit`, danach `docker context use colima`.
2. Images aus dem Profil `default` kopieren. Das ist eine lokale Kopie, kein
   Download. Während eines Laufs wird nichts geladen oder gezogen.

   ```
   for i in ddev/ddev-webserver:v1.25.4-rankscan-built postgres:17-rankscan-built redis:8; do
     docker --context colima save "$i" | docker --context colima-audit load
   done
   ```

3. Abnahmetest laufen lassen (einige Minuten):

   ```
   bash security-audit/tests/acceptance.sh
   ```

   Nur ein vollständiger grüner Lauf schreibt den Nachweis
   `~/security-audit-skill/.sandbox-acceptance.json`. Ein roter Lauf löscht ihn.
   Der Nachweis ist an Colima- und Docker-Version, alle Image-IDs im Profil
   `audit`, den Hash von `sandbox-run.sh` und die Mounts der VM gebunden. Ändert
   sich eines davon, ist der Abnahmetest erneut nötig.

4. Nach dem Audit: `colima stop -p audit`.

## Ablauf pro Agent

Nur der Parent eines Audit-Laufs ruft diese Befehle auf. Er schreibt auch das
Manifest. Hunter- und Verifier-Agents schreiben nur nach `scratch/input/` und
übergeben dem Parent Befehl und gewünschte Ergebnisdateien als Text.

Der Agent-Root folgt dem Skill:
`~/security-audit-skill/<repo>/run-<N>/agents/<agent-id>`.

1. Vorbereiten:

   ```
   security-audit/sandbox-run.sh prepare --agent-root "$ROOT" --target "$REPO" \
     --rw storage --rw bootstrap/cache --include public/build
   ```

   - Legt `scratch.dmg` fester Grösse an und hängt es unter `scratch/` ein.
   - Kopiert nach `src/`, was Git kennt (versioniert oder neu und nicht
     ignoriert), dazu `vendor/` und jeden Pfad aus `--include`.
   - Lässt immer weg: `.git/`, `node_modules/`, `.ddev/`, `.ssh/`, `.aws/`,
     `.env`, `.env.*`, `.env-*`, `*.env`, `.envrc`, `auth.json`, `.npmrc`,
     `.netrc`, `.pgpass`, `*.key`, `*.pem`, `*.p12`, `*.pfx`, `id_rsa*`,
     `id_ecdsa*`, `id_ed25519*`, `id_dsa*`.
   - Submodule und eingebettete Repos fehlen in `src/`. `prepare` nennt sie in
     einem Hinweis. Mit `--include <pfad>` lassen sie sich übernehmen.
   - Scheitert `prepare`, räumt es Image, Kopie und Agent-Root selbst weg.
   - Der Agent-Root darf kein Komma und kein `"` enthalten (`docker --mount`).
   - `--rw PATH` spiegelt die Ordner von `PATH` nach `scratch/rw/PATH`. `exec`
     hängt sie beschreibbar über `src/PATH`.
   - Schreibt `src.ref.json` mit Commit und Dirty-Status.

2. Manifest schreiben, z. B. `"$ROOT/manifest.json"`:

   ```json
   {"max_total_bytes": 1048576, "files": [{"path": "out/junit.xml", "max_bytes": 1048576}]}
   ```

3. Ausführen und übernehmen:

   ```
   label="$(security-audit/sandbox-run.sh label --agent-root "$ROOT")"
   python3 -I security-audit/promote.py --scratch "$ROOT/scratch" --artifacts "$ROOT/artifacts" \
     --manifest "$ROOT/manifest.json" --container-label "$label" -- \
     security-audit/sandbox-run.sh exec --agent-root "$ROOT" \
       --image ddev/ddev-webserver:v1.25.4-rankscan-built --pg postgres:17-rankscan-built \
       --env-file security-audit/env/rankscan.env --rw storage --rw bootstrap/cache -- \
       php vendor/bin/phpunit --do-not-cache-result --log-junit /scratch/out/junit.xml tests/Feature/...
   ```

   `promote.py` gibt eine JSON-Zeile aus: `command_exit`, `interrupted`,
   `containers_left`, `promoted`, `rejected` mit Grund. Exit 0: alles
   übernommen. Exit 1: mindestens eine Datei abgelehnt. Exit 3: ein Container
   lief noch, nichts übernommen.

   `--container-label` ist Pflicht. Nur Tests ohne Docker nutzen stattdessen
   `--no-container-check`. Ctrl-C und SIGTERM gibt `promote.py` an `exec`
   weiter und wartet, bis `exec` die Container entfernt hat.

4. Aufräumen: `security-audit/sandbox-run.sh cleanup --agent-root "$ROOT"`.
   `artifacts/`, `manifest.json` und `src.ref.json` bleiben.

Pro Agent-Root gibt es genau eine Übernahme: `promote.py` verlangt ein leeres
`artifacts/`, und ein zweites `prepare` wird verweigert. Für einen weiteren Lauf
mit Übernahme nimmt der Parent eine neue Agent-ID.

Ergebnisse liest der Parent nur aus `artifacts/`, nie direkt aus `scratch/`.
Zielcode kann in `scratch/` Symlinks auf Host-Dateien legen. Auf dem Host zeigen
sie auf die echte Datei, z. B. einen SSH-Schlüssel.

Ein vollständiges Beispiel ist `tests/probe-rankscan.sh`.

## Kontrollen und Limits

| Kontrolle | Umsetzung | Default | Option |
|---|---|---|---|
| Netz | Test-Container im Netz-Namespace von Postgres (`--network none`), sonst `--network none`; nur `lo` | – | – |
| Umgebung | `env -i` mit genau den Schlüsseln aus `--env-file`; `PATH`, `HOME`, `TMPDIR` Pflicht; `HOME`, `TMPDIR`, `XDG_*`, `COMPOSER_HOME`, `COMPOSER_CACHE_DIR` müssen auf `/scratch` zeigen | – | `--env-file` |
| Dateisystem | `--read-only`, `src/` als `/src:ro`, einziger Schreibort `/scratch` | – | `--rw` |
| CPU | `--cpus` | 2 | `--cpus` |
| Speicher | `--memory`, Swap gleich Speicher | 1 GB | `--memory` |
| Prozesse | `--pids-limit` | 256 | `--pids` |
| Dateigrösse | `--ulimit fsize` | 64 MB | `--fsize` |
| Disk | Grösse von `scratch.dmg` | 512 MB | `--scratch-size` (prepare) |
| Laufzeit | `timeout` im Container, Host-Wächter nach Limit + 15 s | 300 s | `--timeout` |
| Härtung | `--cap-drop ALL`, `no-new-privileges`, uid 65534, `--pull never` | – | – |

Postgres und Redis laufen ebenfalls gehärtet, mit Wegwerf-Daten auf tmpfs und
Dummy-Zugang `db`/`db`, Datenbank `db_test`.

`exec` gibt den Exit-Code des Befehls zurück. Eigene Codes: `90` Aufruffehler,
`91` Vorbedingung verweigert (Nachweis, VM, Pfad, Denylist, Symlink in
`scratch/rw/`). `124`: Zeitlimit. `prepare` und `cleanup` nutzen dieselben
Codes. Die hohen Werte verhindern eine Verwechslung mit Codes des Zielcodes.

Vor jedem Mount prüft `exec`, dass kein Teil von `scratch/rw/<pfad>` ein
Symlink ist. Zielcode aus einem früheren Lauf könnte dort sonst einen Symlink
auf einen fremden Ordner legen.

`SANDBOX_ACCEPTANCE_FILE` setzt einen anderen Pfad für den Nachweis. Das ist nur
für die Tests gedacht. `--unverified-for-acceptance` überspringt die Prüfung des
Nachweises. Nur `acceptance.sh` nutzt diese Option.

## Text für den Auftrag an den Skill

Ersetze `<Datum>` durch `date` aus `~/security-audit-skill/.sandbox-acceptance.json`.

```
Sandbox vorhanden. Zielcode führst du nur über diese Befehle aus:
- Vorbereiten: <quality>/security-audit/sandbox-run.sh prepare
- Ausführen und übernehmen: python3 -I <quality>/security-audit/promote.py ... -- <quality>/security-audit/sandbox-run.sh exec ...
- Aufräumen: <quality>/security-audit/sandbox-run.sh cleanup
Anleitung: <quality>/security-audit/README.md, Abschnitt «Ablauf pro Agent».

Erfüllte Kontrollen (Abnahmetest grün am <Datum>, 20 Fälle):
- Kein Netz nach aussen. Nur Loopback zu Postgres und Redis im selben Namespace.
- Leere Umgebung aus einer Allowlist mit Dummy-Werten; HOME, TMPDIR und Caches auf scratch/.
- Root-Dateisystem und Quelle nur lesbar; einziger Schreibort ist scratch/.
- Limits: 2 CPUs, 1 GB Speicher ohne Swap, 256 Prozesse, 64 MB pro Datei,
  512 MB Scratch, 300 s Laufzeit. Keine Capabilities, uid 65534, no-new-privileges.
- Die Container-VM sieht nur ~/security-audit-skill/.
- promote.py setzt die 11 Schritte aus «Write isolation» um.

Regeln:
- Nur der Parent ruft prepare, exec, cleanup und promote.py auf und schreibt das Manifest.
- Hunter und Verifier schreiben nur nach scratch/input/.
- Verweigert exec den Lauf (command_exit 90 oder 91 im Bericht von promote.py),
  führe keinen Zielcode aus. Melde die Spur als needs_validation mit der
  Meldung von exec als Blocker.
- Ergebnisse nur aus artifacts/ lesen. Dateien in scratch/ nie öffnen oder
  lesen; nur nach scratch/input/ schreiben.
```

## Tests

| Test | Braucht | Befehl |
|---|---|---|
| `promote.py` | Python 3.9+ | `python3 -I -m unittest discover -s security-audit/tests -p 'test_*.py'` |
| `prepare`, `cleanup` | hdiutil | `bash security-audit/tests/test_prepare.sh` |
| Abnahme | Profil `audit`, Images | `bash security-audit/tests/acceptance.sh` |
| Probelauf rankscan | Abnahme-Nachweis | `bash security-audit/tests/probe-rankscan.sh` |

`ACCEPTANCE_CASES="fall1 fall2"` führt nur ausgewählte Fälle aus. Eine
Teilauswahl schreibt keinen Nachweis.

## Bekannte Grenzen

- Nur macOS mit Colima (vmType `vz`, virtiofs). Andere Hosts sind nicht
  vorgesehen.
- `exec` leert vor jedem Lauf die Caches der Audit-VM. Sonst verwechselt
  virtiofs ein neues Scratch-Image mit einem früheren: Jede Image-Wurzel hat
  dieselbe Inode, und macOS vergibt Disk-Nummern neu.
- Der Test-Container läuft ohne `--init`. So zeigt auch `/proc/1/environ` nur
  die Allowlist. Verwaiste Zombie-Prozesse räumt bis zum Ende des Containers
  niemand weg. Für kurze Läufe ist das unkritisch.
- Die Installation als Claude-Code-Plugin klont das ganze Repo. Dort liegt
  `security-audit/` mit. Die Hooks des Plugins rufen es nicht auf.
- Laufen zwei Audits gleichzeitig, teilen sie sich die Audit-VM. Die Agent-Roots
  und Container-Labels sind getrennt.
