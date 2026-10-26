#!/usr/bin/env bash
# Abnahmetest der Sandbox. Jeder Fall muss seine Grenze greifen sehen.
# Braucht das Colima-Profil audit und die Images aus README.md.
# Kein set -e: run_case wertet jeden Fall selbst aus (siehe lib.sh).

HERE="$(cd "$(dirname "$0")" && pwd)"
SANDBOX="$HERE/../sandbox-run.sh"
. "$HERE/lib.sh"

IMAGE="ddev/ddev-webserver:v1.25.4-rankscan-built"
PG_IMAGE="postgres:17-rankscan-built"
ENV_FILE="$HERE/acceptance.env"
ACC="$HOME/security-audit-skill/_acceptance"
REPO="$ACC/repo"
AGENTS="$ACC/run-1/agents"
DOCKER=(docker --context colima-audit)

make_repo() {
  rm -rf "$REPO"
  mkdir -p "$REPO"
  (
    cd "$REPO"
    git init -q
    printf 'quelle\n' > datei.txt
    mkdir data && printf 'x\n' > data/.keep
    git add datei.txt data/.keep
    git -c user.name=t -c user.email=t@example.invalid commit -q -m init
  )
}

agent() { # name [scratch-grösse] -> gibt den Agent-Root aus
  local root="$AGENTS/$1"
  "$SANDBOX" cleanup --agent-root "$root" >/dev/null 2>&1
  rm -rf "$root"
  "$SANDBOX" prepare --agent-root "$root" --target "$REPO" --scratch-size "${2:-64m}" >/dev/null || return 1
  printf '%s\n' "$root"
}

# Führt einen Befehl in der Sandbox aus, ohne Abnahme-Nachweis.
# Ausgabe: stdout und stderr des Laufs, danach eine Zeile «EXIT=<code>».
sx() { # agent-root [exec-optionen] -- befehl...
  local root="$1" rc=0 out
  shift
  out="$("$SANDBOX" exec --agent-root "$root" --image "$IMAGE" --env-file "$ENV_FILE" \
    --unverified-for-acceptance "$@" 2>&1)" || rc=$?
  printf '%s\nEXIT=%s\n' "$out" "$rc"
}

containers_with_label() { # agent-root
  "${DOCKER[@]}" ps -aq --filter "label=$("$SANDBOX" label --agent-root "$1")"
}

finish_agent() { # agent-root
  "$SANDBOX" cleanup --agent-root "$1" >/dev/null
}

# --- Fälle -----------------------------------------------------------------

guard_refuses_without_proof() {
  local root rc=0 out
  root="$(agent guard)"
  out="$(SANDBOX_ACCEPTANCE_FILE="$ACC/gibt-es-nicht.json" "$SANDBOX" exec --agent-root "$root" \
    --image "$IMAGE" --env-file "$ENV_FILE" -- true 2>&1)" || rc=$?
  finish_agent "$root"
  assert_eq 91 "$rc" "Exit ohne Nachweis"
  assert_contains "$out" "Nachweis"
  assert_contains "$out" "sandbox-run.sh: VERWEIGERT:"
}

network_external_blocked() {
  local root out
  root="$(agent net)"
  out="$(sx "$root" -- sh -c 'curl -sS -m 5 https://example.com >/dev/null 2>&1; echo "rc1=$?"
    curl -sS -m 5 http://1.1.1.1 >/dev/null 2>&1; echo "rc2=$?"; echo "--- netdev"; cat /proc/net/dev')"
  finish_agent "$root"
  assert_contains "$out" "rc1="
  assert_not_contains "$out" "rc1=0"
  assert_not_contains "$out" "rc2=0"
  assert_contains "$out" "lo:"
  # /proc/net/dev: zwei Kopfzeilen, dann eine Zeile pro Schnittstelle.
  assert_eq "lo:" "$(printf '%s\n' "$out" | sed -n '/^--- netdev$/,/^EXIT=/p' | sed '1,3d;$d' | awk '{print $1}' | tr '\n' ' ' | sed 's/ $//')" "Netzwerk-Schnittstellen"
}

network_loopback_to_pg() {
  local root out
  root="$(agent loop)"
  out="$(sx "$root" --pg "$PG_IMAGE" -- php -r 'new PDO("pgsql:host=127.0.0.1;dbname=db_test","db","db"); echo "PG-OK";')"
  finish_agent "$root"
  assert_contains "$out" "PG-OK"
  assert_contains "$out" "EXIT=0"
}

network_loopback_to_redis() {
  local root out
  root="$(agent redis)"
  out="$(sx "$root" --pg "$PG_IMAGE" --redis redis:8 -- bash -c 'sleep 2; exec 3<>/dev/tcp/127.0.0.1/6379
    printf "PING\r\n" >&3; head -c 5 <&3')"
  finish_agent "$root"
  assert_contains "$out" "+PONG"
}

env_only_allowlist() {
  local root out pid1 want got
  root="$(agent env)"
  out="$(sx "$root" -- env)"
  # PID 1 ohne Shell lesen: eine Shell würde selbst PWD setzen.
  pid1="$(sx "$root" -- sed -z 's/$/\n/' /proc/1/environ)"
  finish_agent "$root"
  want="$(grep -v '^#' "$ENV_FILE" | grep '=' | cut -d= -f1 | sort | tr '\n' ' ')"
  got="$(printf '%s\n' "$out" | grep -v '^sandbox-run.sh' | grep -v '^EXIT=' | grep '=' | cut -d= -f1 | sort | tr '\n' ' ')"
  assert_eq "$want" "$got" "Umgebung"
  # Auch PID 1 darf keine Image-Umgebung und kein HOSTNAME zeigen.
  got="$(printf '%s\n' "$pid1" | grep -v '^sandbox-run.sh' | grep -v '^EXIT=' | grep '=' | cut -d= -f1 | sort | tr '\n' ' ')"
  assert_eq "$want" "$got" "Umgebung von PID 1"
}

env_paths_must_point_to_scratch() {
  local root out rc bad="$ACC/env-falsch.env" line key
  root="$(agent envpath)"
  for line in HOME=/home/x HOME=/scratch/../x TMPDIR=/scratch/. XDG_STATE_HOME=/home/x XDG_RUNTIME_DIR=/run/x; do
    key="${line%%=*}"
    { grep -v "^$key=" "$ENV_FILE"; echo "$line"; } > "$bad"
    rc=0
    out="$("$SANDBOX" exec --agent-root "$root" --image "$IMAGE" --env-file "$bad" \
      --unverified-for-acceptance -- true 2>&1)" || rc=$?
    assert_eq 90 "$rc" "Exit bei $line"
    assert_contains "$out" "$key"
    assert_contains "$out" "AUFRUFFEHLER"
  done
  rm -f "$bad"
  finish_agent "$root"
}

# Leerzeichen und Umlaut im Pfad des Agent-Roots, mit --rw-Mount.
paths_with_space_and_umlaut() {
  local root out
  root="$ACC/rün 1/agents/space"
  "$SANDBOX" cleanup --agent-root "$root" >/dev/null 2>&1
  rm -rf "$ACC/rün 1"
  "$SANDBOX" prepare --agent-root "$root" --target "$REPO" --scratch-size 64m --rw data >/dev/null
  out="$(sx "$root" --rw data -- sh -c 'touch /scratch/out/x && touch /src/data/y && echo PFAD-OK')"
  finish_agent "$root"
  rm -rf "$ACC/rün 1"
  assert_contains "$out" "PFAD-OK"
}

readonly_src_and_root() {
  local root out n
  root="$(agent ro)"
  out="$(sx "$root" -- sh -c 'touch /src/x; touch /x; touch /tmp/x; touch /scratch/out/x && echo SCRATCH-OK')"
  finish_agent "$root"
  n="$(printf '%s\n' "$out" | grep -c 'Read-only file system')"
  assert_eq 3 "$n" "Anzahl Read-only-Meldungen"
  assert_contains "$out" "SCRATCH-OK"
}

hardening() {
  local root out
  root="$(agent hard)"
  out="$(sx "$root" -- sh -c 'echo "uid=$(id -u)"; grep -E "^(CapEff|NoNewPrivs)" /proc/self/status')"
  finish_agent "$root"
  assert_contains "$out" "uid=65534"
  assert_contains "$out" "$(printf 'CapEff:\t0000000000000000')"
  assert_contains "$out" "$(printf 'NoNewPrivs:\t1')"
}

vm_sees_only_audit_root() {
  local fp
  if colima ssh -p audit -- test -e "$HOME/.ssh" 2>/dev/null; then fail "VM sieht $HOME/.ssh"; fi
  fp="$("$SANDBOX" fingerprint)"
  assert_eq "[\"$HOME/security-audit-skill\"]" \
    "$(python3 -I -c 'import json,sys; print(json.dumps(json.loads(sys.argv[1])["vm_mounts"]))' "$fp")" "vm_mounts"
}

# Mehrere Läufe nacheinander. macOS vergibt Disk-Nummern neu, und die Wurzel
# jedes APFS-Images hat dieselbe Inode. Die VM darf das neue Scratch-Image
# nicht mit einem alten Cache-Eintrag verwechseln.
scratch_visible_in_sequence() {
  local i root out
  for i in 1 2 3 4 5; do
    root="$(agent "seq$i")"
    out="$(sx "$root" -- sh -c 'touch /scratch/out/x && echo SCRATCH-OK')"
    finish_agent "$root"
    assert_contains "$out" "SCRATCH-OK"
  done
}

pids_limit() {
  local root out
  root="$(agent pids)"
  out="$(sx "$root" --pids 64 --timeout 90 -- bash -c 'for i in $(seq 1 500); do sleep 30 & done 2>&1 | tail -1
    echo "--- pids"; cat /sys/fs/cgroup/pids.max /sys/fs/cgroup/pids.events')"
  finish_agent "$root"
  assert_contains "$out" "Resource temporarily unavailable"
  assert_eq 64 "$(printf '%s\n' "$out" | sed -n '/^--- pids$/{n;p;}')" "pids.max"
  [ "$(printf '%s\n' "$out" | awk '$1 == "max" {print $2}')" -gt 0 ] || fail "pids.events zählt keinen Treffer"
}

memory_oom() {
  local root out
  root="$(agent mem)"
  out="$(sx "$root" --memory 256m -- sh -c 'head -c 1G /dev/zero | tail; echo "rc=$?"
    echo "max=$(cat /sys/fs/cgroup/memory.max)"; echo "swap=$(cat /sys/fs/cgroup/memory.swap.max)"
    cat /sys/fs/cgroup/memory.events')"
  finish_agent "$root"
  assert_contains "$out" "max=268435456"
  assert_contains "$out" "swap=0"
  assert_not_contains "$out" "rc=0"
  [ "$(printf '%s\n' "$out" | awk '$1 == "oom_kill" {print $2}')" -ge 1 ] || fail "oom_kill ist 0: $out"
}

fsize_limit() {
  local root out
  root="$(agent fsize)"
  out="$(sx "$root" --fsize 8m -- sh -c 'dd if=/dev/zero of=/scratch/out/f bs=1M count=32 2>/dev/null; echo "rc=$?"
    echo "size=$(stat -c %s /scratch/out/f)"')"
  finish_agent "$root"
  assert_not_contains "$out" "rc=0"
  assert_contains "$out" "size=8388608"
}

disk_limit() {
  local root out size
  root="$(agent disk 32m)"
  out="$(sx "$root" --fsize 128m -- sh -c 'dd if=/dev/zero of=/scratch/out/f bs=1M count=64; echo "rc=$?"
    echo "size=$(stat -c %s /scratch/out/f)"')"
  finish_agent "$root"
  assert_contains "$out" "No space left on device"
  assert_not_contains "$out" "rc=0"
  size="$(printf '%s\n' "$out" | sed -n 's/^size=//p')"
  [ "$size" -lt 33554432 ] || fail "Datei hat $size Bytes, Scratch hat 32 MB"
}

timeout_kills() {
  local root out start dur
  root="$(agent timeout)"
  start=$(date +%s)
  out="$(sx "$root" --timeout 5 -- sleep 60)"
  dur=$(($(date +%s) - start))
  finish_agent "$root"
  # 124: timeout im Container hat beendet. Der Host-Wächter (Limit + 15 s)
  # wäre langsamer und lieferte 137.
  assert_contains "$out" "EXIT=124"
  [ "$dur" -lt 15 ] || fail "Lauf dauerte $dur s"
}

promote_end_to_end() {
  local root label out rc=0
  root="$(agent promote)"
  label="$("$SANDBOX" label --agent-root "$root")"
  cat >"$root/manifest.json" <<'JSON'
{"max_total_bytes": 4096, "files": [
  {"path": "out/ok.txt", "max_bytes": 1024}, {"path": "out/link", "max_bytes": 1024},
  {"path": "out/h2.txt", "max_bytes": 1024}, {"path": "out/fifo", "max_bytes": 1024}]}
JSON
  out="$(python3 -I "$HERE/../promote.py" --scratch "$root/scratch" --artifacts "$root/artifacts" \
    --manifest "$root/manifest.json" --container-label "$label" -- \
    "$SANDBOX" exec --agent-root "$root" --image "$IMAGE" --env-file "$ENV_FILE" --unverified-for-acceptance -- \
    sh -c 'cd /scratch/out && echo inhalt > ok.txt && echo h > h1.txt && ln h1.txt h2.txt &&
      ln -s /etc/passwd link && mkfifo fifo' 2>/dev/null)" || rc=$?
  assert_eq 1 "$rc" "Exit von promote.py"
  assert_eq "inhalt" "$(cat "$root/artifacts/out/ok.txt")" "übernommener Inhalt"
  for f in link h2.txt fifo; do
    [ ! -e "$root/artifacts/out/$f" ] && [ ! -L "$root/artifacts/out/$f" ] || fail "$f wurde übernommen"
  done
  python3 -I -c '
import json, sys
r = json.loads(sys.argv[1])
assert r["command_exit"] == 0, r
assert [p["path"] for p in r["promoted"]] == ["out/ok.txt"], r
reasons = {x["path"]: x["reason"].split(":")[0] for x in r["rejected"]}
assert reasons == {"out/link": "symlink", "out/h2.txt": "hardlink", "out/fifo": "not-regular"}, reasons
' "$out" || fail "Bericht: $out"
  finish_agent "$root"
}

guard_detects_fingerprint_mismatch() {
  local root fp out rc=0
  root="$(agent guard2)"
  fp="$("$SANDBOX" fingerprint)"
  python3 -I -c '
import json, sys
fp = json.loads(sys.argv[1]); fp.update(result="green", date="test", cases=[])
json.dump(fp, open(sys.argv[2], "w"))
fp["sandbox_run_sha256"] = "0" * 64
json.dump(fp, open(sys.argv[3], "w"))
' "$fp" "$ACC/proof-ok.json" "$ACC/proof-bad.json"
  out="$(SANDBOX_ACCEPTANCE_FILE="$ACC/proof-bad.json" "$SANDBOX" exec --agent-root "$root" \
    --image "$IMAGE" --env-file "$ENV_FILE" -- true 2>&1)" || rc=$?
  assert_eq 91 "$rc" "Exit bei verfälschtem Nachweis"
  assert_contains "$out" "sandbox_run_sha256"
  SANDBOX_ACCEPTANCE_FILE="$ACC/proof-ok.json" "$SANDBOX" exec --agent-root "$root" \
    --image "$IMAGE" --env-file "$ENV_FILE" -- true >/dev/null 2>&1 || fail "Lauf mit passendem Nachweis scheiterte"
  rm -f "$ACC/proof-ok.json" "$ACC/proof-bad.json"
  finish_agent "$root"
}

# Zielcode ersetzt scratch/rw/data durch einen Symlink. Das nächste exec auf
# denselben Agent-Root darf ihm nicht folgen.
rw_symlink_refused() {
  local root out rc=0
  root="$AGENTS/rwlink"
  "$SANDBOX" cleanup --agent-root "$root" >/dev/null 2>&1
  rm -rf "$root"
  "$SANDBOX" prepare --agent-root "$root" --target "$REPO" --scratch-size 64m --rw data >/dev/null
  sx "$root" --rw data -- sh -c 'mv /scratch/rw/data /scratch/rw/data.alt && ln -s / /scratch/rw/data' >/dev/null
  [ -L "$root/scratch/rw/data" ] || fail "Symlink wurde nicht angelegt"
  out="$("$SANDBOX" exec --agent-root "$root" --image "$IMAGE" --env-file "$ENV_FILE" \
    --unverified-for-acceptance --rw data -- ls /src/data 2>&1)" || rc=$?
  finish_agent "$root"
  assert_eq 91 "$rc" "Exit bei Symlink in scratch/rw"
  assert_contains "$out" "Symlink"

  # Variante: scratch/rw selbst wird zum Symlink.
  rm -rf "$root"
  "$SANDBOX" prepare --agent-root "$root" --target "$REPO" --scratch-size 64m --rw data >/dev/null
  sx "$root" --rw data -- sh -c 'mv /scratch/rw /scratch/rw.alt && ln -s / /scratch/rw' >/dev/null
  [ -L "$root/scratch/rw" ] || fail "Symlink scratch/rw wurde nicht angelegt"
  rc=0
  out="$("$SANDBOX" exec --agent-root "$root" --image "$IMAGE" --env-file "$ENV_FILE" \
    --unverified-for-acceptance --rw data -- ls /src/data 2>&1)" || rc=$?
  finish_agent "$root"
  assert_eq 91 "$rc" "Exit bei Symlink scratch/rw"
}

cleanup_after_sigterm() {
  local root pid
  root="$(agent term)"
  "$SANDBOX" exec --agent-root "$root" --image "$IMAGE" --env-file "$ENV_FILE" \
    --unverified-for-acceptance --pg "$PG_IMAGE" --timeout 77 -- sleep 60 >/dev/null 2>&1 &
  pid=$!
  sleep 12
  [ -n "$(containers_with_label "$root")" ] || fail "Container liefen gar nicht"
  kill -TERM "$pid"
  wait "$pid" 2>/dev/null || true
  assert_eq "" "$(containers_with_label "$root")" "Container nach SIGTERM"
  # Der Host-Wächter (sleep 77 + 15) darf den Abbruch nicht überleben. Er
  # träfe sonst später einen neuen Lauf auf demselben Agent-Root.
  sleep 1
  if pgrep -f 'sleep 92' >/dev/null; then fail "Host-Wächter läuft nach SIGTERM weiter"; fi
  finish_agent "$root"
}

# --- Ablauf ----------------------------------------------------------------

ALL_CASES="guard_refuses_without_proof guard_detects_fingerprint_mismatch network_external_blocked
  network_loopback_to_pg network_loopback_to_redis env_only_allowlist env_paths_must_point_to_scratch
  paths_with_space_and_umlaut readonly_src_and_root scratch_visible_in_sequence hardening
  vm_sees_only_audit_root pids_limit memory_oom fsize_limit disk_limit timeout_kills promote_end_to_end
  rw_symlink_refused cleanup_after_sigterm"
PROOF="$HOME/security-audit-skill/.sandbox-acceptance.json"

# Schreibt den Nachweis nur nach einem vollständigen, grünen Lauf.
# Ein roter Lauf löscht einen bestehenden Nachweis.
write_proof() {
  if [ "$FAILED" -ne 0 ]; then
    rm -f "$PROOF"
    echo "Nachweis gelöscht: Abnahme rot"
    return
  fi
  [ -z "${ACCEPTANCE_CASES:-}" ] || { echo "Nachweis unverändert: nur Teilauswahl gelaufen"; return; }
  python3 -I -c '
import datetime, json, os, sys
fp = json.loads(sys.argv[1])
fp.update(result="green", cases=sys.argv[2].split(),
          date=datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds"))
tmp = sys.argv[3] + ".tmp"
with open(tmp, "w") as f:
    json.dump(fp, f, indent=2, sort_keys=True)
os.replace(tmp, sys.argv[3])
' "$("$SANDBOX" fingerprint)" "$ALL_CASES" "$PROOF"
  echo "Nachweis geschrieben: $PROOF"
}

make_repo
for c in ${ACCEPTANCE_CASES:-$ALL_CASES}; do
  run_case "$c"
done
write_proof
finish
