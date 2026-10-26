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
    git add datei.txt
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
  local label
  label="$(printf '%s' "$1" | shasum -a 256 | cut -c1-12)"
  "${DOCKER[@]}" ps -aq --filter "label=security-audit.agent=$label"
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
  assert_eq 3 "$rc" "Exit ohne Nachweis"
  assert_contains "$out" "Nachweis"
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

env_only_allowlist() {
  local root out want got
  root="$(agent env)"
  out="$(sx "$root" -- env)"
  finish_agent "$root"
  want="$(grep -v '^#' "$ENV_FILE" | grep '=' | cut -d= -f1 | sort | tr '\n' ' ')"
  got="$(printf '%s\n' "$out" | grep -v '^EXIT=' | grep '=' | cut -d= -f1 | sort | tr '\n' ' ')"
  assert_eq "$want" "$got" "Umgebung"
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

cleanup_after_sigterm() {
  local root pid
  root="$(agent term)"
  "$SANDBOX" exec --agent-root "$root" --image "$IMAGE" --env-file "$ENV_FILE" \
    --unverified-for-acceptance --pg "$PG_IMAGE" -- sleep 60 >/dev/null 2>&1 &
  pid=$!
  sleep 12
  [ -n "$(containers_with_label "$root")" ] || fail "Container liefen gar nicht"
  kill -TERM "$pid"
  wait "$pid" 2>/dev/null || true
  assert_eq "" "$(containers_with_label "$root")" "Container nach SIGTERM"
  finish_agent "$root"
}

# --- Ablauf ----------------------------------------------------------------

make_repo
for c in ${ACCEPTANCE_CASES:-guard_refuses_without_proof network_external_blocked network_loopback_to_pg \
  env_only_allowlist readonly_src_and_root scratch_visible_in_sequence hardening vm_sees_only_audit_root \
  cleanup_after_sigterm}; do
  run_case "$c"
done
finish
