# Sandbox für den security-audit-Skill – Umsetzungsplan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eine lokale Sandbox, die alle Ausführungsvorgaben des Skills `security-audit` nachweislich erfüllt, plus ein race-sicheres Übernahme-Werkzeug.

**Architecture:** `sandbox-run.sh` (bash) bereitet pro Agent eine Wegwerf-Quellkopie und ein hdiutil-Scratch vor, startet gehärtete Container im Colima-Profil `audit` und räumt auf. `promote.py` (Python-Standardbibliothek) hält die Verzeichnis-Deskriptoren über den Lauf, startet `exec` als Kindprozess und übernimmt danach erlaubte Dateien nach den 11 Schritten. `acceptance.sh` beweist jede Grenze und schreibt einen Nachweis, ohne den `exec` nicht läuft.

**Tech Stack:** bash 3.2 (macOS), Python 3.9.6 (Host, Standardbibliothek), Docker 29.5.2 über Colima 0.10.3 (Kontext `colima-audit`), hdiutil, node:test für den Verteilungstest.

**Spec:** `docs/superpowers/specs/2026-10-26-security-audit-sandbox-design.md`

## Global Constraints

- Alle neuen Dateien liegen unter `security-audit/`. Ausnahme: `.gitattributes`, `composer.json`, `lib/distribution.test.mjs`.
- Docker immer mit `--context colima-audit`. Nie `docker context use` aufrufen.
- Agent-Root muss unter `$HOME/security-audit-skill/` liegen (nur dieser Pfad ist in der Audit-VM eingehängt). Das ersetzt «unter `$HOME`» aus dem Design.
- Agent-ID: `^[a-z0-9][a-z0-9_-]{0,63}$`, nicht `con`, `prn`, `aux`, `nul`, `com1`–`com9`, `lpt1`–`lpt9`.
- Keine Images bauen oder ziehen. Erlaubte Images: `ddev/ddev-webserver:v1.25.4-rankscan-built`, `postgres:17-rankscan-built`, `redis:8`.
- Python-Code läuft unter 3.9: `from __future__ import annotations`, kein `match`, keine Abhängigkeit ausser Standardbibliothek. Aufruf mit `python3 -I`.
- Nie die echte `.env` von rankscan lesen, kopieren oder ausgeben.
- Kein `/tmp` als beschreibbarer Ausweichort. Testdaten liegen unter `$HOME/security-audit-skill/_test/`.
- Kommentare, Meldungen und README auf Deutsch, Stil wie im Repo (kurze Sätze, aktiv).
- Default-Limits: `--cpus 2`, `--memory 1g`, Swap = Speicher (fest), `--pids 256`, `--fsize 64m`, Scratch `512m`, `--timeout 300`.
- Exit-Codes `sandbox-run.sh`: `2` Aufruffehler, `3` Vorbedingung verweigert (Kontext, Pfad, Nachweis, Denylist), sonst der Exit-Code des Befehls.
- Commits auf dem Task-Branch, Nachricht auf Deutsch, Trailer wie in den bisherigen Commits.

## Review Focus

1. **Pfad mit Leerzeichen oder Umlaut im Agent-Root oder Ziel-Repo** – alles funktioniert; Task 4 prüft einen Ziel-Repo-Pfad mit Leerzeichen.
2. **Abbruch mitten in `exec` (Ctrl-C, SIGTERM)** – kein Container mit dem Label bleibt übrig; Task 5 prüft das mit `kill -TERM` auf `exec`.
3. **Zweites `prepare` auf denselben Agent-Root** – verweigert mit Exit 3, überschreibt nichts; Task 4.
4. **Datei in der Allowlist, die der Zielcode gar nicht erzeugt hat** – wird als `missing` verworfen, der Rest wird trotzdem übernommen; Task 2.
5. **Zielcode legt in `scratch/out/` einen Symlink auf eine Host-Datei an** – `promote.py` lehnt ab, ohne dem Link zu folgen; Task 6 (Ende-zu-Ende) und Task 2 (Unit).

---

### Task 1: Ordner aus der Paket-Verteilung ausschliessen

**Files:**
- Create: `.gitattributes`
- Modify: `composer.json` (neuer Schlüssel `archive`)
- Create: `lib/distribution.test.mjs`
- Create: `security-audit/.keep` (nur bis Task 2, dann löschen)

**Interfaces:**
- Produces: keine.

- [ ] **Step 1: Test schreiben** – `lib/distribution.test.mjs`, Stil wie `lib/args.test.mjs`:
  - `test('package.json: files nennt security-audit nicht')` – `files` enthält keinen Eintrag, der mit `security-audit` beginnt.
  - `test('gitattributes: security-audit ist export-ignore')` – `.gitattributes` enthält die Zeile `/security-audit export-ignore`.
  - `test('composer.json: archive.exclude enthält /security-audit')`.
  - `test('git archive: enthält security-audit nicht')` – `git archive HEAD` mit `--worktree-attributes`, Ausgabe per `tar -t`; keine Zeile beginnt mit `security-audit/`. Setzt voraus, dass `security-audit/.keep` committet ist.
- [ ] **Step 2: Test rot sehen** – `node --test lib/distribution.test.mjs`. Erwartet: drei Fehlschläge (gitattributes, composer, git archive).
- [ ] **Step 3: Umsetzen** – `.gitattributes` mit `/security-audit export-ignore`; in `composer.json` `"archive": { "exclude": ["/security-audit"] }`.
- [ ] **Step 4: Test grün** – `node --test lib/distribution.test.mjs` und `npm test`. Erwartet: alles grün. Zusätzlich `npm pack --dry-run 2>&1 | grep security-audit` ohne Treffer.
- [ ] **Step 5: Commit** – `build: security-audit/ aus der Paket-Verteilung ausschliessen`.

### Task 2: promote.py – Übernahme einer Datei

**Files:**
- Create: `security-audit/promote.py`
- Test: `security-audit/tests/test_promote.py`

**Interfaces:**
- Produces (in `promote.py`):
  - `@dataclass(frozen=True) class Entry: path: str; max_bytes: int`
  - `@dataclass(frozen=True) class Manifest: files: tuple[Entry, ...]; max_total_bytes: int`
  - `class PromoteError(Exception)` – Grund als Text, Präfix ist ein Code: `invalid-path`, `not-allowed`, `missing`, `symlink`, `not-regular`, `hardlink`, `too-large`, `total-exceeded`, `changed`, `dest-exists`, `dest-not-dir`.
  - `@dataclass class Result: path: str; status: str; reason: str | None; bytes: int` – `status` ist `promoted` oder `rejected`.
  - `load_manifest(path: str) -> Manifest` – JSON `{"max_total_bytes": int, "files": [{"path": str, "max_bytes": int}]}`; doppelte Pfade, Werte ≤ 0 oder fehlende Schlüssel → `ValueError`.
  - `split_rel_path(rel: str) -> list[str]` – Schritt 1; wirft `PromoteError("invalid-path: …")` bei leer, absolut, `.`, `..`, leerem Segment, NUL.
  - `promote_file(scratch_fd: int, artifacts_fd: int, entry: Entry, remaining_total: int, *, _after_copy=None) -> int` – Schritte 2–8 und 10; gibt kopierte Bytes zurück. `_after_copy(src_fd)` ist ein Test-Hook zwischen Kopieren und zweitem `fstat`.
  - `promote_all(scratch_fd: int, artifacts_fd: int, manifest: Manifest) -> list[Result]` – ruft `promote_file` je Eintrag, führt das Gesamtbudget, Schritt 11: bei Fehler halb geschriebenes Ziel per `unlinkat` relativ zum Ziel-Ordner-Deskriptor entfernen und weitermachen.

- [ ] **Step 1: Tests schreiben** – `unittest`, Fixture-Ordner unter `$HOME/security-audit-skill/_test/promote-<pid>/{scratch,artifacts}`, Deskriptoren per `os.open(..., O_DIRECTORY)`. Tests:
  - `test_promotes_regular_file` – `out/a.txt` (5 Bytes) → Ziel `out/a.txt` mit gleichem Inhalt, `Result.status == "promoted"`, `bytes == 5`.
  - `test_rejects_invalid_paths` – für `""`, `"/etc/passwd"`, `"."`, `"../x"`, `"out/../x"`, `"out//x"`: `PromoteError` mit Präfix `invalid-path`.
  - `test_rejects_symlink_leaf` – `out/l` → `/etc/hosts`: Präfix `symlink`, Ziel existiert nicht.
  - `test_rejects_symlink_parent` – `out` ist Symlink auf einen Ordner mit `a.txt`: Präfix `symlink`.
  - `test_rejects_hardlink` – `out/h` mit `os.link`: Präfix `hardlink`.
  - `test_rejects_fifo_without_blocking` – `os.mkfifo('out/f')`; Test läuft mit `signal.alarm(5)` und erwartet Präfix `not-regular` in < 5 s.
  - `test_rejects_directory` – `out/d/` als Eintrag: Präfix `not-regular`.
  - `test_rejects_per_file_limit` – 11 Bytes bei `max_bytes=10`: Präfix `too-large`.
  - `test_rejects_total_limit` – zwei Dateien à 6 Bytes, `max_total_bytes=10`: erste `promoted`, zweite `rejected` mit `total-exceeded`.
  - `test_rejects_change_during_copy` – `_after_copy` hängt ein Byte an die Quelle an: Präfix `changed`, Ziel entfernt.
  - `test_rejects_existing_destination` – Ziel existiert schon: Präfix `dest-exists`, Ziel unverändert.
  - `test_rejects_symlink_in_destination_parent` – `artifacts/out` ist Symlink: Präfix `dest-not-dir` oder `symlink`, nichts ausserhalb von `artifacts/` geschrieben.
  - `test_missing_file_is_rejected_others_promoted` – Manifest mit `out/missing` und `out/a.txt`: `missing` und `promoted`.
  - `test_load_manifest_rejects_duplicates_and_bad_limits`.
- [ ] **Step 2: Tests rot sehen** – `python3 -I -m unittest discover -s security-audit/tests -p 'test_promote.py' -v`. Erwartet: `ModuleNotFoundError` bzw. Fehlschläge. (Import über `sys.path.insert(0, <security-audit/>)` im Test.)
- [ ] **Step 3: Umsetzen** – Flags: Ordner `O_RDONLY | O_DIRECTORY | O_NOFOLLOW`, Quelle `O_RDONLY | O_NOFOLLOW | O_NONBLOCK`, Ziel `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, Modus `0o600`; alle Öffnungen mit `dir_fd=`. `ELOOP` bzw. `ENOTDIR` beim Öffnen → `symlink`. Typprüfung per `stat.S_ISREG`. Identität für «changed»: `st_dev`, `st_ino`, `st_mode`, `st_nlink`, `st_size`, `st_mtime_ns`. Lesen in Blöcken bis genau `st_size`; ein weiterer `read` muss 0 liefern, sonst `changed`. Fehlende Zielordner: `os.mkdir(name, 0o700, dir_fd=…)`, dann no-follow öffnen und `S_ISDIR` prüfen. Schritt 9: beim Import `os.supports_dir_fd` und `os.supports_follow_symlinks` prüfen; fehlt etwas, `promote_all` verwirft alles mit `unsupported-platform`.
- [ ] **Step 4: Tests grün** – gleicher Befehl. Erwartet: alle OK.
- [ ] **Step 5: Commit** – `feat(security-audit): promote.py übernimmt einzelne Dateien race-sicher`. `security-audit/.keep` löschen.

### Task 3: promote.py – Wrapper um den Lauf

**Files:**
- Modify: `security-audit/promote.py` (`main`)
- Test: `security-audit/tests/test_promote.py`

**Interfaces:**
- Consumes: `load_manifest`, `promote_all`, `Result` aus Task 2.
- Produces: CLI
  `promote.py --scratch DIR --artifacts DIR --manifest FILE [--container-label LABEL] -- CMD [ARGS…]`
  - Reihenfolge: Manifest laden → beide Deskriptoren öffnen (Python setzt `O_CLOEXEC`; zusätzlich `os.set_inheritable(fd, False)` prüfen) → `subprocess.run(CMD, close_fds=True)` → bei `--container-label` prüfen, dass `docker --context colima-audit ps -aq --filter label=LABEL` leer ist → `promote_all`.
  - Ausgabe auf stdout, eine JSON-Zeile: `{"command_exit": int, "containers_left": bool, "promoted": [{"path","bytes"}], "rejected": [{"path","reason"}]}`.
  - Exit: `0` keine Ablehnung; `1` mindestens eine Ablehnung; `3` Container übrig (dann nichts übernommen, alle Einträge `rejected` mit `containers-left`); `2` Aufruffehler.
  - `artifacts/` muss existieren und leer sein, sonst Exit 2.

- [ ] **Step 1: Tests schreiben**
  - `test_cli_runs_command_then_promotes` – CMD ist `python3 -c` und schreibt `out/a.txt` in Scratch; JSON hat `command_exit == 0`, `a.txt` in `promoted`, Exit 0.
  - `test_cli_reports_command_exit_but_still_promotes` – CMD schreibt Datei und endet mit 7: `command_exit == 7`, Exit 0.
  - `test_open_roots_not_inheritable` – `open_roots(scratch, artifacts) -> tuple[int, int]` (von `main` genutzt): für beide Deskriptoren gilt `os.get_inheritable(fd) is False`.
  - `test_cli_rejects_nonempty_artifacts` – Exit 2.
- [ ] **Step 2: rot sehen** – `python3 -I -m unittest … -v`.
- [ ] **Step 3: Umsetzen** – `argparse`; `open_roots` als eigene Funktion.
- [ ] **Step 4: grün sehen**.
- [ ] **Step 5: Commit** – `feat(security-audit): promote.py hält die Deskriptoren über den Lauf`.

### Task 4: sandbox-run.sh – prepare und cleanup

**Files:**
- Create: `security-audit/sandbox-run.sh` (ausführbar, `set -euo pipefail`)
- Create: `security-audit/tests/lib.sh` (Hilfen `assert_eq`, `assert_contains`, `assert_exit`, `fail`, Zähler; Ausgabe `ok`/`FEHLER` je Fall, Exit ≠ 0 bei einem Fehler)
- Test: `security-audit/tests/test_prepare.sh`

**Interfaces:**
- Produces:
  - `sandbox-run.sh prepare --agent-root DIR --target REPO [--scratch-size 512m] [--rw PATH]…`
    - Exit 3: Agent-Root nicht unter `$HOME/security-audit-skill/`, Agent-Root im Ziel-Repo, Agent-ID ungültig (Agent-ID = Basisname des Agent-Roots), Agent-Root existiert schon nicht leer, Ziel kein Git-Repo, Denylist-Treffer nach dem Kopieren.
    - Legt an: `scratch.dmg` (APFS, `-size`), Mount `scratch/` mit `-nobrowse`, Modus 0777; darin `home tmp cache input out rw` (0777); je `--rw PATH` die Ordnerstruktur von `REPO/PATH` unter `scratch/rw/PATH` (nur Ordner, 0777).
    - `src/`: Dateien aus `git -C REPO ls-files -z --cached --others --exclude-standard` (gelöschte überspringen) plus `REPO/vendor/`, wenn vorhanden. Ausgeschlossen überall: `.git/`, `node_modules/`, `.ddev/`, `.env`, `.env.*`, `auth.json`, `*.key`, `*.pem`. Symlinks bleiben Symlinks. `src/` danach `chmod -R a+rX`.
    - `src.ref.json`: `{"commit": "<sha>", "dirty": bool, "target": "<abs path>"}`.
    - `artifacts/` leer angelegt (0700).
  - `sandbox-run.sh cleanup --agent-root DIR` – Container mit Label entfernen (verträgt fehlenden Docker-Kontext mit Warnung), Image aushängen (`diskutil eject`, sonst `hdiutil detach -force`), `src/`, `scratch.dmg`, `scratch/` löschen. `artifacts/`, `manifest.json`, `src.ref.json` bleiben. Idempotent.
  - Label-Wert: `security-audit.agent=<erste 12 Zeichen von shasum -a 256 des Agent-Roots>`. Funktion `agent_label` im Skript; Container-Namen `sa-<label>-test|pg|redis`.

- [ ] **Step 1: Tests schreiben** – Fixture-Repo unter `$HOME/security-audit-skill/_test/repo mit leerzeichen/` mit: `app.php` (versioniert), `new.php` (unversioniert, nicht ignoriert), `.gitignore` mit `ignored.txt` und `storage/*.key`, `ignored.txt`, `.env`, `.env.testing`, `storage/oauth.key`, `storage/logs/` (mit `.gitkeep` versioniert), `vendor/pkg/a.php`, `vendor/pkg/.env.example`, `vendor/bin/tool` → Symlink `../pkg/a.php`. Fälle:
  - `prepare_copies_tracked_untracked_and_vendor` – `src/app.php`, `src/new.php`, `src/vendor/pkg/a.php` vorhanden; `src/vendor/bin/tool` ist Symlink.
  - `prepare_excludes_ignored_and_secrets` – `ignored.txt`, `.env`, `.env.testing`, `storage/oauth.key`, `vendor/pkg/.env.example`, `.git` fehlen in `src/`.
  - `prepare_creates_scratch_image_with_limit` – `df -k scratch` meldet Grösse ≤ `--scratch-size 32m`; `stat -f %Lp scratch` ist `777`.
  - `prepare_mirrors_rw_dirs` – mit `--rw storage`: `scratch/rw/storage/logs/` existiert, enthält keine Dateien.
  - `prepare_writes_source_ref` – `src.ref.json` hat `commit` = `git rev-parse HEAD`, `dirty` = `true` (wegen `new.php`).
  - `prepare_refuses_outside_audit_root` – Agent-Root `$HOME/sa-x/agents/a` → Exit 3.
  - `prepare_refuses_bad_agent_id` – Basisname `Bad` und `com1` → Exit 3.
  - `prepare_refuses_second_run` – zweites `prepare` auf denselben Root → Exit 3, `src/app.php` unverändert.
  - `cleanup_removes_copy_and_image_keeps_artifacts` – nach `cleanup`: kein Mount (`mount | grep` leer), `src/` und `scratch.dmg` weg, `artifacts/` da; zweites `cleanup` Exit 0.
- [ ] **Step 2: rot sehen** – `bash security-audit/tests/test_prepare.sh`. Erwartet: Fehler, Skript fehlt.
- [ ] **Step 3: Umsetzen** – Kopie per `bsdtar --null -T - -cf -` aus der `ls-files`-Liste und `tar -xf - -C src` (bzw. ein gleichwertiger Weg, der `--exclude` für alle Muster beachtet); danach Denylist-Kontrolle mit `find src` gegen dieselben Muster.
- [ ] **Step 4: grün sehen** – alle Fälle `ok`.
- [ ] **Step 5: Commit** – `feat(security-audit): sandbox-run.sh prepare und cleanup`.

### Task 5: sandbox-run.sh – exec, Fingerprint und Abnahme-Sperre

**Files:**
- Modify: `security-audit/sandbox-run.sh`
- Create: `security-audit/tests/acceptance.sh` (Grundgerüst plus Fälle dieses Tasks)

**Interfaces:**
- Consumes: `prepare`, `cleanup`, `agent_label` aus Task 4.
- Produces:
  - `sandbox-run.sh fingerprint` – JSON auf stdout: `{"colima_version", "docker_server_version" (Kontext colima-audit), "images": {"repo:tag": "sha256:…"} (alle Images im Kontext, sortiert), "sandbox_run_sha256", "vm_mounts": [Liste der virtiofs-Ziele aus `colima ssh -p audit -- findmnt -t virtiofs -n -o TARGET`]}`.
  - Nachweis-Datei `$HOME/security-audit-skill/.sandbox-acceptance.json`: Fingerprint plus `{"date": ISO-8601, "result": "green", "cases": [Namen]}`.
  - `sandbox-run.sh exec --agent-root DIR --image IMG --env-file FILE [--pg IMG] [--redis IMG] [--cpus N] [--memory SIZE] [--pids N] [--fsize SIZE] [--timeout SEK] [--rw PATH]… [--workdir DIR] [--unverified-for-acceptance] -- CMD…`
    - Vorbedingungen, sonst Exit 3: Kontext `colima-audit` erreichbar; `vm_mounts` ist genau `["$HOME/security-audit-skill"]`; Nachweis vorhanden, `result == green`, Fingerprint gleich (ohne `date`, `cases`). `--unverified-for-acceptance` überspringt nur die Nachweis-Prüfung und schreibt eine Warnung auf stderr.
    - env-file: Zeilen `KEY=VALUE`, `#`-Kommentare und Leerzeilen erlaubt, Schlüssel `^[A-Z_][A-Z0-9_]*$`, Pflicht: `PATH`, `HOME`, `TMPDIR`. Sonst Exit 2.
    - Test-Container: Optionen exakt wie im Design, Abschnitt `exec`. Befehl im Container: `env -i <KEY=VALUE aus env-file…> timeout --kill-after=5 <SEK> CMD…`. Arbeitsordner Default `/src`.
    - Postgres (`--pg`): `--network none`, `--user postgres`, `--read-only`, `--tmpfs /var/lib/postgresql/data:rw,size=256m,uid=999,gid=999,mode=0700`, `--tmpfs /var/run/postgresql:rw,size=1m,uid=999,gid=999`, `--tmpfs /tmp:rw,size=16m,uid=999,gid=999`, `--cap-drop ALL`, `--security-opt no-new-privileges`, `--cpus 1 --memory 512m --memory-swap 512m --pids-limit 128`, env `POSTGRES_USER=db POSTGRES_PASSWORD=db POSTGRES_DB=db_test`. Bereit per `pg_isready -h 127.0.0.1`, höchstens 30 s, sonst Exit 3.
    - Redis (`--redis`, nur mit `--pg`): `--network container:<pg>`, `--user redis`, `--read-only`, `--tmpfs /data:size=64m,uid=999,gid=999`, gleiche Härtung und Limits wie Postgres, Befehl `redis-server --save '' --appendonly no --bind 127.0.0.1`.
    - Host-Wächter: nach `SEK + 15` `docker kill` auf den Test-Container. `trap` auf EXIT, INT, TERM entfernt alle Container mit dem Label.

- [ ] **Step 1: Abnahmefälle schreiben** – `acceptance.sh` legt je Fall einen Agent-Root unter `$HOME/security-audit-skill/_acceptance/<fall>/` an (Fixture-Repo aus einer Datei, Scratch `64m`), ruft `prepare`, `exec --unverified-for-acceptance`, `cleanup`. Test-Image: `ddev/ddev-webserver:v1.25.4-rankscan-built`. Fälle dieses Tasks:
  - `guard_refuses_without_proof` – `exec` ohne Flag und ohne Nachweis-Datei (Datei vorher wegbewegen, danach zurück): Exit 3, Meldung nennt den Nachweis.
  - `network_external_blocked` – im Container `curl -sS -m 5 https://example.com` und `curl -sS -m 5 http://1.1.1.1`: beide Exit ≠ 0; `cat /proc/net/dev` enthält ausser Kopfzeilen nur `lo:`.
  - `network_loopback_to_pg` – mit `--pg`: `php -r 'new PDO("pgsql:host=127.0.0.1;dbname=db_test","db","db"); echo "PG-OK";'` gibt `PG-OK`.
  - `env_only_allowlist` – `env | cut -d= -f1 | sort` gleich den sortierten Schlüsseln des Test-env-files.
  - `readonly_src_and_root` – `touch /src/x`, `touch /x`, `touch /tmp/x`: je Exit ≠ 0 und `Read-only file system`; `touch /scratch/out/x` gelingt.
  - `hardening` – `id -u` = `65534`; `grep CapEff /proc/self/status` = `0000000000000000`; `grep NoNewPrivs /proc/self/status` = `1`.
  - `vm_sees_only_audit_root` – `colima ssh -p audit -- test -e $HOME/.ssh` Exit ≠ 0; `fingerprint` liefert `vm_mounts == ["$HOME/security-audit-skill"]`.
  - `cleanup_after_sigterm` – `exec … -- sleep 60` im Hintergrund, nach 5 s `kill -TERM`; danach `docker --context colima-audit ps -aq --filter label=…` leer.
- [ ] **Step 2: rot sehen** – `bash security-audit/tests/acceptance.sh`. Erwartet: `exec` unbekannt.
- [ ] **Step 3: Umsetzen** – `exec` und `fingerprint` wie oben.
- [ ] **Step 4: grün sehen** – alle Fälle dieses Tasks `ok`. Greift eine Grenze nicht, ist das ein Befund: Ursache klären (superpowers:systematic-debugging), nicht den Test lockern.
- [ ] **Step 5: Commit** – `feat(security-audit): sandbox-run.sh exec mit Netz-, Env- und Schreibgrenzen`.

### Task 6: Abnahme der Ressourcen-Grenzen und Nachweis

**Files:**
- Modify: `security-audit/tests/acceptance.sh`

**Interfaces:**
- Consumes: `exec`, `fingerprint` aus Task 5; `promote.py`-CLI aus Task 3.
- Produces: Nachweis-Datei (Format in Task 5), geschrieben nur, wenn alle Fälle grün sind. Bei Rot wird eine bestehende Nachweis-Datei gelöscht.

- [ ] **Step 1: Fälle schreiben**
  - `pids_limit` – `--pids 64`; im Container `bash -c 'for i in $(seq 1 500); do sleep 30 & done; cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/pids.events'`: Ausgabe enthält `Resource temporarily unavailable`, `pids.max` = `64`, `pids.events` hat `max N` mit N > 0.
  - `memory_oom` – `--memory 256m`; `sh -c 'head -c 1G /dev/zero | tail; cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.swap.max /sys/fs/cgroup/memory.events'`: `memory.max` = `268435456`, `memory.swap.max` = `0`, `oom_kill` ≥ 1.
  - `fsize_limit` – `--fsize 8m`, Scratch `64m`; `dd if=/dev/zero of=/scratch/out/f bs=1M count=32`: Exit ≠ 0, Meldung `File too large`; `stat -c %s /scratch/out/f` = `8388608`.
  - `disk_limit` – Scratch `32m`, `--fsize 128m`; `dd … count=64`: `No space left on device`; Datei < 32 MB.
  - `timeout_kills` – `--timeout 5`, `sleep 60`: Exit 124 oder 137; Dauer gemessen auf dem Host < 30 s.
  - `promote_end_to_end` – Container schreibt `out/ok.txt` und `out/h1.txt`, legt `out/link` → `/etc/passwd` (Symlink), `out/h2.txt` (Hardlink auf `h1.txt`) und `mkfifo out/fifo` an. Lauf über `promote.py --container-label … -- sandbox-run.sh exec …`, Manifest mit `out/ok.txt`, `out/link`, `out/h2.txt`, `out/fifo`. Erwartet: `ok.txt` `promoted` mit gleichem Inhalt; `link` `symlink`; `h2.txt` `hardlink`; `fifo` `not-regular`; promote-Exit 1.
- [ ] **Step 2: rot oder grün sehen** – `bash security-audit/tests/acceptance.sh`. Jeder rote Fall ist eine nicht greifende Grenze: Ursache klären und in `exec` beheben. Lässt sich eine Grenze unter Colima nicht durchsetzen, Arbeit anhalten und René fragen.
- [ ] **Step 3: Nachweis schreiben lassen** – am Ende von `acceptance.sh`: alle grün → `fingerprint` plus `date`, `result`, `cases` atomar (temp-Datei im selben Ordner, `mv`) schreiben.
- [ ] **Step 4: Sperre prüfen** – `exec` liest den Nachweis-Pfad aus `SANDBOX_ACCEPTANCE_FILE`, Default `$HOME/security-audit-skill/.sandbox-acceptance.json` (nur für Tests; README nennt das). Fall `guard_detects_fingerprint_mismatch` in `acceptance.sh`: Nachweis aus dem aktuellen Fingerprint in eine Testdatei schreiben, `sandbox_run_sha256` verfälschen, `exec` ohne Flag → Exit 3, Meldung nennt `sandbox_run_sha256`. Mit unverfälschter Testdatei → `exec … -- true` Exit 0.
- [ ] **Step 5: Commit** – `test(security-audit): Abnahmetest für alle Grenzen, Nachweis als Voraussetzung`.

### Task 7: Probelauf rankscan

**Files:**
- Create: `security-audit/env/rankscan.env`
- Create: `security-audit/tests/probe-rankscan.sh`

**Interfaces:**
- Consumes: `prepare`, `exec`, `cleanup`, `promote.py`.

- [ ] **Step 1: env-file schreiben** – nur Dummy-Werte: `PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`, `HOME=/scratch/home`, `TMPDIR=/scratch/tmp`, `XDG_CACHE_HOME=/scratch/cache`, `COMPOSER_HOME=/scratch/cache/composer`, `APP_ENV=testing`, `APP_KEY=base64:` + 32 feste Null-Bytes base64 (`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=`), `DB_CONNECTION=pgsql`, `DB_HOST=127.0.0.1`, `DB_PORT=5432`, `DB_DATABASE=db_test`, `DB_USERNAME=db`, `DB_PASSWORD=db`. Kopfkommentar: «Nur Dummy-Werte. Nie echte Secrets eintragen.»
- [ ] **Step 2: Probe-Skript schreiben** – Agent-Root `$HOME/security-audit-skill/_probe-rankscan/run-1/agents/probe` (vorher `cleanup` und Löschen, falls vorhanden); `prepare --target $HOME/projects/rankscan/application --rw storage --rw bootstrap/cache`; Manifest `{"max_total_bytes": 1048576, "files": [{"path": "out/junit.xml", "max_bytes": 1048576}]}`; `promote.py --container-label … -- sandbox-run.sh exec --image ddev/ddev-webserver:v1.25.4-rankscan-built --pg postgres:17-rankscan-built --env-file security-audit/env/rankscan.env --rw storage --rw bootstrap/cache -- php vendor/bin/phpunit --log-junit /scratch/out/junit.xml tests/Feature/Middleware/EnsureUserIsAdminTest.php`; danach `cleanup`. Prüft: `artifacts/out/junit.xml` existiert, `tests` > 0, `failures="0"`, `errors="0"`.
- [ ] **Step 3: Probelauf ausführen** – `bash security-audit/tests/probe-rankscan.sh`. Erwartet: grün.
  - Scheitert die DB-Verbindung an `DB_HOST=db`: Das Probe-Skript legt nach `prepare` eine Kopie von `src/phpunit.xml` mit `DB_HOST=127.0.0.1` in `scratch/input/phpunit.xml` und ruft phpunit mit `--configuration /scratch/input/phpunit.xml`. Befund im Commit festhalten.
  - Andere Fehler: superpowers:systematic-debugging. Kein Netz, keine echte `.env` als Abkürzung.
- [ ] **Step 4: Prüfen, dass keine echte .env im Spiel war** – `find <agent-root>/src -name '.env*'` leer (vor `cleanup` im Skript).
- [ ] **Step 5: Commit** – `test(security-audit): Probelauf mit einem rankscan-Feature-Test`.

### Task 8: README

**Files:**
- Create: `security-audit/README.md`

- [ ] **Step 1: README schreiben** – Abschnitte:
  1. Zweck und Vertrauensgrenze (Profil `audit`, nur `~/security-audit-skill/`).
  2. Einmalige Einrichtung: `colima start -p audit --cpu 4 --memory 4 --disk 40 --vm-type vz --mount-type virtiofs --mount ~/security-audit-skill:w`, danach `docker context use colima` (Colima stellt den Kontext sonst um).
  3. Vor jedem Audit: Images per `docker --context colima save … | docker --context colima-audit load` übernehmen; `bash security-audit/tests/acceptance.sh`; Nachweis prüfen.
  4. Ablauf pro Agent: `prepare` → Manifest schreiben → `promote.py … -- sandbox-run.sh exec …` → `cleanup`. Rollen: nur der Parent ruft diese Befehle; Agents schreiben nur nach `scratch/input/`.
  5. Limits mit Defaults und Optionen (Tabelle aus dem Design).
  6. Textblock für den Auftrag an den Skill, wörtlich kopierbar: Sandbox vorhanden; Pfade zu `sandbox-run.sh` und `promote.py`; erfüllte Kontrollen mit Werten; Datum des Nachweises; Regel «Zielcode nur über diese Befehle ausführen; ohne gültigen Nachweis nicht ausführen und als needs_validation melden».
  7. Bekannte Grenzen: Plugin-Installation klont das ganze Repo; Host nur macOS mit Colima.
- [ ] **Step 2: Befehle der README gegen das Skript prüfen** – jeder Befehl im Text läuft mit `--help` bzw. als Trockenlauf ohne Aufruffehler.
- [ ] **Step 3: Commit** – `docs(security-audit): README für Audit-Läufe mit Sandbox`.

### Task 9: Gesamtprüfung

- [ ] **Step 1:** `npm test` – grün.
- [ ] **Step 2:** `python3 -I -m unittest discover -s security-audit/tests -p 'test_*.py'` – grün.
- [ ] **Step 3:** `bash security-audit/tests/test_prepare.sh` – grün.
- [ ] **Step 4:** `bash security-audit/tests/acceptance.sh` – grün, Nachweis geschrieben.
- [ ] **Step 5:** `bash security-audit/tests/probe-rankscan.sh` – grün.
- [ ] **Step 6:** `git archive HEAD | tar -t | grep -c '^security-audit/'` = `0`.
- [ ] **Step 7:** `docker context ls` zeigt `colima` als aktiven Kontext; kein Container mit Label `security-audit.agent` läuft in `colima-audit`; `mount | grep security-audit-skill` leer.
