#!/usr/bin/env bash
# Tests für «sandbox-run.sh prepare» und «cleanup». Sie brauchen hdiutil, aber kein Docker.
# Kein set -e: run_case wertet jeden Fall selbst aus (siehe lib.sh).

HERE="$(cd "$(dirname "$0")" && pwd)"
SANDBOX="$HERE/../sandbox-run.sh"
. "$HERE/lib.sh"

BASE="$HOME/security-audit-skill/_test/prepare"
REPO="$BASE/repo mit leerzeichen"
AGENTS="$BASE/run-1/agents"

make_repo() {
  rm -rf "$REPO"
  mkdir -p "$REPO/storage/logs" "$REPO/vendor/pkg" "$REPO/vendor/bin"
  (
    cd "$REPO"
    git init -q
    printf '<?php\n' > app.php
    printf 'ignored.txt\nstorage/*.key\n.env\n.env.*\n/vendor/\n/public/build/\n' > .gitignore
    : > storage/logs/.gitkeep
    # Eingebettetes Repo als gitlink, wie ein Submodul.
    mkdir sub && (cd sub && git init -q && printf 'x\n' > s.txt && printf 'geheim\n' > ignoriert.txt &&
      printf 'ignoriert.txt\n' > .gitignore && git add s.txt .gitignore &&
      git -c user.name=t -c user.email=t@example.invalid commit -q -m sub)
    git add app.php .gitignore storage/logs/.gitkeep
    git add sub 2>/dev/null
    git -c user.name=t -c user.email=t@example.invalid commit -q -m init
    printf '<?php // neu\n' > new.php
    printf 'geheim\n' > ignored.txt
    printf 'APP_KEY=echt\n' > .env
    printf 'APP_KEY=echt\n' > .env.testing
    printf 'schluessel\n' > storage/oauth.key
    printf '<?php\n' > vendor/pkg/a.php
    printf 'X=1\n' > vendor/pkg/.env.example
    printf 'export TOKEN=echt\n' > vendor/pkg/.envrc
    printf 'export TOKEN=echt\n' > .envrc
    mkdir -p docker/prod.env tests/fixtures/id_rsa_keys
    printf 'services: {}\n' > docker/prod.env/compose.yml
    printf 'x\n' > tests/fixtures/id_rsa_keys/readme.txt
    git add docker tests
    mkdir -p .ssh .aws conf
    for f in .npmrc .netrc .pgpass id_rsa id_ed25519 .ssh/config .aws/credentials conf/cert.p12 conf/cert.pfx \
      conf/prod.env .env-local; do printf 'geheim\n' > "$f"; done
    ln -s ../pkg/a.php vendor/bin/tool
    mkdir -p public/build/assets
    printf '{}' > public/build/manifest.json
    printf 'x' > public/build/assets/app.js
    printf 'geheim' > public/build/server.key
  )
}

cleanup_all() {
  local d
  for d in "$AGENTS"/*; do
    [ -d "$d" ] && "$SANDBOX" cleanup --agent-root "$d" >/dev/null 2>&1
  done
  rm -rf "$AGENTS"
}

prepare_agent() { # id [weitere Argumente]
  local id="$1"
  shift
  "$SANDBOX" prepare --agent-root "$AGENTS/$id" --target "$REPO" --scratch-size 32m "$@"
}

prepare_copies_tracked_untracked_and_vendor() {
  prepare_agent copy >/dev/null
  local src="$AGENTS/copy/src"
  [ -f "$src/app.php" ] || fail "app.php fehlt"
  [ -f "$src/new.php" ] || fail "new.php fehlt"
  [ -f "$src/vendor/pkg/a.php" ] || fail "vendor/pkg/a.php fehlt"
  [ -L "$src/vendor/bin/tool" ] || fail "vendor/bin/tool ist kein Symlink"
}

prepare_excludes_dirs_with_secret_names() {
  local src="$AGENTS/copy/src"
  [ -f "$src/app.php" ] || fail "src/ fehlt"
  [ ! -e "$src/docker/prod.env" ] || fail "Ordner prod.env wurde kopiert"
  [ ! -e "$src/tests/fixtures/id_rsa_keys" ] || fail "Ordner id_rsa_keys wurde kopiert"
}

prepare_reports_denylist_skips() {
  local err
  err="$(prepare_agent deny 2>&1 >/dev/null)"
  assert_contains "$err" "Denylist"
  assert_contains "$err" ".npmrc"
}

prepare_excludes_ignored_and_secrets() {
  local src="$AGENTS/copy/src" f
  [ -f "$src/app.php" ] || fail "src/ fehlt"
  for f in ignored.txt .env .env.testing .envrc storage/oauth.key vendor/pkg/.env.example vendor/pkg/.envrc .git \
    .npmrc .netrc .pgpass id_rsa id_ed25519 .ssh .aws conf/cert.p12 conf/cert.pfx conf/prod.env .env-local; do
    [ ! -e "$src/$f" ] || fail "$f darf nicht in src/ liegen"
  done
}

prepare_creates_scratch_image_with_limit() {
  local scratch="$AGENTS/copy/scratch" kb
  mount | grep -q " on $scratch " || fail "scratch/ ist nicht eingehängt"
  kb=$(df -k "$scratch" | awk 'NR==2 {print $2}')
  [ "$kb" -le 32768 ] || fail "Scratch hat $kb KB, erlaubt 32768"
  assert_eq 777 "$(stat -f %Lp "$scratch")" "Modus von scratch/"
  for d in home tmp cache input out rw; do
    [ -d "$scratch/$d" ] || fail "scratch/$d fehlt"
  done
}

prepare_writes_source_ref() {
  local ref="$AGENTS/copy/src.ref.json" head
  head=$(git -C "$REPO" rev-parse HEAD)
  assert_eq "$head" "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["commit"])' "$ref")"
  assert_eq True "$(python3 -I -c 'import json,sys; print(json.load(open(sys.argv[1]))["dirty"])' "$ref")"
}

prepare_mirrors_rw_dirs() {
  prepare_agent rwdirs --rw storage >/dev/null
  local rw="$AGENTS/rwdirs/scratch/rw/storage"
  [ -d "$rw/logs" ] || fail "scratch/rw/storage/logs fehlt"
  assert_eq "" "$(find "$rw" -type f)" "Dateien in scratch/rw/storage"
}

prepare_includes_extra_paths() {
  prepare_agent incl --include public/build >/dev/null
  local src="$AGENTS/incl/src"
  [ -f "$src/public/build/manifest.json" ] || fail "public/build/manifest.json fehlt"
  [ -f "$src/public/build/assets/app.js" ] || fail "public/build/assets/app.js fehlt"
  [ ! -e "$src/public/build/server.key" ] || fail "Denylist gilt nicht für --include"
  [ ! -e "$AGENTS/copy/src/public/build" ] || fail "public/build ohne --include kopiert"
}

prepare_rejects_include_outside_repo() {
  assert_exit 90 prepare_agent inclbad --include ../x
}

label_is_canonical() {
  local a b c
  a="$("$SANDBOX" label --agent-root "$AGENTS/copy")"
  b="$("$SANDBOX" label --agent-root "$AGENTS/copy/")"
  c="$("$SANDBOX" label --agent-root "$AGENTS//copy")"
  assert_contains "$a" "security-audit.agent="
  assert_eq "$a" "$b" "Label mit Schrägstrich am Ende"
  assert_eq "$a" "$c" "Label mit doppeltem Schrägstrich"
}

prepare_skips_submodule_with_warning() {
  local err
  err="$(prepare_agent subm 2>&1 >/dev/null)"
  [ -f "$AGENTS/subm/src/app.php" ] || fail "src/ fehlt"
  [ ! -e "$AGENTS/subm/src/sub" ] || fail "Submodul wurde kopiert"
  assert_contains "$err" "sub"
  assert_contains "$err" "--include"
}

label_refuses_invalid_root() {
  local out rc=0
  out="$("$SANDBOX" label --agent-root "$HOME/sa-ausserhalb/agents/a" 2>/dev/null)" || rc=$?
  assert_eq 91 "$rc" "Exit von label"
  assert_eq "" "$out" "Ausgabe von label"
}

prepare_refuses_comma_via_symlink() {
  mkdir -p "$BASE/run,x"
  ln -sfn "$BASE/run,x" "$BASE/linkroot"
  assert_exit 91 "$SANDBOX" prepare --agent-root "$BASE/linkroot/a" --target "$REPO"
  [ ! -e "$BASE/run,x/a" ] || fail "Agent-Root hinter dem Symlink wurde angelegt"
  rm -rf "$BASE/linkroot" "$BASE/run,x"
}

prepare_sigterm_cleans_up() {
  local pid i=0
  # Grosse Datei, damit die Kopie nach dem Einhängen Zeit braucht.
  mkdir -p "$REPO/gross"
  dd if=/dev/zero of="$REPO/gross/blob" bs=1m count=600 2>/dev/null
  # Direkt starten: $! muss die PID von sandbox-run.sh sein, nicht einer Subshell.
  "$SANDBOX" prepare --agent-root "$AGENTS/sig" --target "$REPO" --scratch-size 32m --include gross >/dev/null 2>&1 &
  pid=$!
  until mount | grep -q "agents/sig/scratch"; do
    i=$((i + 1))
    [ "$i" -lt 200 ] || break
    sleep 0.05
  done
  kill -TERM "$pid"
  wait "$pid" 2>/dev/null || true
  rm -rf "$REPO/gross"
  if mount | grep -q "agents/sig/scratch"; then fail "scratch/ blieb nach SIGTERM eingehängt"; fi
  [ ! -e "$AGENTS/sig" ] || fail "Agent-Root blieb nach SIGTERM liegen"
}

# Zwei prepare auf denselben leeren Agent-Root. Ein ls-Ersatz hält beide nach
# der Leer-Prüfung an, bis beide sie bestanden haben. So trifft der Test das
# Fenster zwischen Prüfung und Anlegen jedes Mal.
prepare_concurrent_keeps_winner() {
  local root="$AGENTS/race" bin="$BASE/race-bin" barrier="$BASE/race-barrier" pa pb rca=0 rcb=0
  mkdir -p "$root" "$bin" "$barrier"
  cat > "$bin/ls" <<EOF
#!/bin/sh
touch "$barrier/\$\$"
i=0
while [ "\$(/bin/ls "$barrier" | wc -l)" -lt 2 ] && [ "\$i" -lt 200 ]; do sleep 0.05; i=\$((i + 1)); done
exec /bin/ls "\$@"
EOF
  chmod 755 "$bin/ls"
  PATH="$bin:$PATH" "$SANDBOX" prepare --agent-root "$root" --target "$REPO" --scratch-size 32m >/dev/null 2>&1 &
  pa=$!
  PATH="$bin:$PATH" "$SANDBOX" prepare --agent-root "$root" --target "$REPO" --scratch-size 32m >/dev/null 2>&1 &
  pb=$!
  wait "$pa" || rca=$?
  wait "$pb" || rcb=$?
  rm -rf "$bin" "$barrier"
  assert_eq 1 "$(( (rca == 0) + (rcb == 0) ))" "Anzahl Erfolge (Exit $rca und $rcb)"
  assert_eq 91 "$(( rca + rcb ))" "Exit des Verlierers"
  mount | grep -q " on $root/scratch " || fail "scratch/ des Gewinners ist nicht eingehängt"
  [ -f "$root/src/app.php" ] || fail "src/ des Gewinners fehlt"
  [ -d "$root/artifacts" ] || fail "artifacts/ des Gewinners fehlt"
}

prepare_refuses_missing_rw_before_mount() {
  assert_exit 91 prepare_agent fail --rw gibtsnicht
  if mount | grep -q "agents/fail/scratch"; then fail "scratch/ blieb eingehängt"; fi
  prepare_agent fail >/dev/null || fail "zweiter Versuch scheiterte"
}

prepare_failure_after_mount_cleans_up() {
  local rc=0
  mkdir -p "$REPO/geschuetzt"
  printf 'x' > "$REPO/geschuetzt/datei"
  chmod 000 "$REPO/geschuetzt/datei"
  prepare_agent late --include geschuetzt >/dev/null 2>&1 || rc=$?
  chmod 600 "$REPO/geschuetzt/datei"
  rm -rf "$REPO/geschuetzt"
  [ "$rc" -ne 0 ] || fail "prepare meldete Erfolg trotz unlesbarer Datei"
  if mount | grep -q "agents/late/scratch"; then fail "scratch/ blieb eingehängt"; fi
  [ ! -e "$AGENTS/late" ] || fail "Agent-Root blieb liegen"
}

prepare_refuses_comma_or_quote_in_root() {
  assert_exit 91 "$SANDBOX" prepare --agent-root "$BASE/run,1/agents/a" --target "$REPO"
  assert_exit 91 "$SANDBOX" prepare --agent-root "$BASE/run\"1/agents/a" --target "$REPO"
}

prepare_refuses_outside_audit_root() {
  assert_exit 91 "$SANDBOX" prepare --agent-root "$HOME/sa-ausserhalb/agents/a" --target "$REPO"
  [ ! -e "$HOME/sa-ausserhalb" ] || fail "Ordner ausserhalb wurde angelegt"
}

prepare_refuses_bad_agent_id() {
  assert_exit 91 prepare_agent Bad
  assert_exit 91 prepare_agent com1
  assert_exit 91 prepare_agent -x
}

prepare_refuses_second_run() {
  printf 'markiert\n' >> "$AGENTS/copy/src/app.php"
  assert_exit 91 prepare_agent copy
  assert_contains "$(cat "$AGENTS/copy/src/app.php")" "markiert"
}

prepare_refuses_target_without_git() {
  mkdir -p "$BASE/kein-repo"
  assert_exit 91 "$SANDBOX" prepare --agent-root "$AGENTS/nogit" --target "$BASE/kein-repo"
}

cleanup_removes_copy_and_image_keeps_artifacts() {
  local root="$AGENTS/copy"
  "$SANDBOX" cleanup --agent-root "$root" >/dev/null
  if mount | grep -q " on $root/scratch "; then fail "scratch/ ist noch eingehängt"; fi
  [ ! -e "$root/src" ] || fail "src/ existiert noch"
  [ ! -e "$root/scratch.dmg" ] || fail "scratch.dmg existiert noch"
  [ -d "$root/artifacts" ] || fail "artifacts/ fehlt"
  assert_exit 0 "$SANDBOX" cleanup --agent-root "$root"
}

cleanup_all
make_repo
run_case prepare_copies_tracked_untracked_and_vendor
run_case prepare_excludes_ignored_and_secrets
run_case prepare_creates_scratch_image_with_limit
run_case prepare_writes_source_ref
run_case prepare_mirrors_rw_dirs
run_case prepare_includes_extra_paths
run_case prepare_rejects_include_outside_repo
run_case prepare_skips_submodule_with_warning
run_case prepare_concurrent_keeps_winner
run_case prepare_refuses_missing_rw_before_mount
run_case prepare_sigterm_cleans_up
run_case prepare_refuses_comma_via_symlink
run_case label_refuses_invalid_root
run_case prepare_excludes_dirs_with_secret_names
run_case prepare_reports_denylist_skips
run_case prepare_failure_after_mount_cleans_up
run_case prepare_refuses_comma_or_quote_in_root
run_case label_is_canonical
run_case prepare_refuses_outside_audit_root
run_case prepare_refuses_bad_agent_id
run_case prepare_refuses_second_run
run_case prepare_refuses_target_without_git
run_case cleanup_removes_copy_and_image_keeps_artifacts
cleanup_all
rm -rf "$BASE"
finish
