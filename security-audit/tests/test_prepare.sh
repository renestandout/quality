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
    printf 'ignored.txt\nstorage/*.key\n.env\n.env.*\n/vendor/\n' > .gitignore
    : > storage/logs/.gitkeep
    git add app.php .gitignore storage/logs/.gitkeep
    git -c user.name=t -c user.email=t@example.invalid commit -q -m init
    printf '<?php // neu\n' > new.php
    printf 'geheim\n' > ignored.txt
    printf 'APP_KEY=echt\n' > .env
    printf 'APP_KEY=echt\n' > .env.testing
    printf 'schluessel\n' > storage/oauth.key
    printf '<?php\n' > vendor/pkg/a.php
    printf 'X=1\n' > vendor/pkg/.env.example
    ln -s ../pkg/a.php vendor/bin/tool
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

prepare_excludes_ignored_and_secrets() {
  local src="$AGENTS/copy/src" f
  [ -f "$src/app.php" ] || fail "src/ fehlt"
  for f in ignored.txt .env .env.testing storage/oauth.key vendor/pkg/.env.example .git; do
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

prepare_refuses_outside_audit_root() {
  assert_exit 3 "$SANDBOX" prepare --agent-root "$HOME/sa-ausserhalb/agents/a" --target "$REPO"
  [ ! -e "$HOME/sa-ausserhalb" ] || fail "Ordner ausserhalb wurde angelegt"
}

prepare_refuses_bad_agent_id() {
  assert_exit 3 prepare_agent Bad
  assert_exit 3 prepare_agent com1
  assert_exit 3 prepare_agent -x
}

prepare_refuses_second_run() {
  printf 'markiert\n' >> "$AGENTS/copy/src/app.php"
  assert_exit 3 prepare_agent copy
  assert_contains "$(cat "$AGENTS/copy/src/app.php")" "markiert"
}

prepare_refuses_target_without_git() {
  mkdir -p "$BASE/kein-repo"
  assert_exit 3 "$SANDBOX" prepare --agent-root "$AGENTS/nogit" --target "$BASE/kein-repo"
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
run_case prepare_refuses_outside_audit_root
run_case prepare_refuses_bad_agent_id
run_case prepare_refuses_second_run
run_case prepare_refuses_target_without_git
run_case cleanup_removes_copy_and_image_keeps_artifacts
cleanup_all
rm -rf "$BASE"
finish
