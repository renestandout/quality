#!/usr/bin/env bash
# Sandbox für den security-audit-Skill.
#
#   sandbox-run.sh prepare --agent-root DIR --target REPO [--scratch-size 512m] [--rw PATH]...
#   sandbox-run.sh cleanup --agent-root DIR
#
# Nur der Parent eines Audit-Laufs ruft dieses Skript auf. Details: README.md.
# Exit-Codes: 2 Aufruffehler, 3 Vorbedingung verweigert.

set -euo pipefail

AUDIT_ROOT="$HOME/security-audit-skill"
DOCKER_CONTEXT="colima-audit"
SCRATCH_DIRS="home tmp cache input out rw"

die() { # code meldung
  echo "sandbox-run.sh: $2" >&2
  exit "$1"
}

realpath_py() {
  python3 -I -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$1"
}

# Pfadteile, die nie in die Quellkopie gelangen. Gilt für jede Tiefe.
is_denied() { # relativer-pfad
  local IFS=/ part base
  for part in $1; do
    case "$part" in .git | node_modules | .ddev) return 0 ;; esac
  done
  base="${1##*/}"
  case "$base" in .env | .env.* | auth.json | *.key | *.pem) return 0 ;; esac
  return 1
}

valid_agent_id() {
  local id="$1"
  [[ "$id" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || return 1
  case "$id" in con | prn | aux | nul | com[1-9] | lpt[1-9]) return 1 ;; esac
  return 0
}

# Prüft den Agent-Root und gibt seinen kanonischen Pfad aus.
check_agent_root() { # pfad
  local root audit
  [[ "$1" = /* ]] || die 3 "--agent-root muss absolut sein: $1"
  root="$(realpath_py "$1")"
  audit="$(realpath_py "$AUDIT_ROOT")"
  [[ "$root" = "$audit"/?* ]] || die 3 "--agent-root muss unter $AUDIT_ROOT liegen: $1"
  valid_agent_id "$(basename "$root")" || die 3 "ungültige Agent-ID: $(basename "$root")"
  printf '%s\n' "$root"
}

check_rel_path() { # pfad
  case "/$1/" in
    *"/../"* | *"/./"* | *"//"*) die 2 "--rw muss ein relativer Pfad ohne . und .. sein: $1" ;;
  esac
  [[ "$1" != /* && -n "$1" ]] || die 2 "--rw muss ein relativer Pfad sein: $1"
}

agent_label() { # agent-root
  printf '%s' "$1" | shasum -a 256 | cut -c1-12
}

is_mounted() { # pfad
  mount | grep -qF " on $1 ("
}

# Listet die Dateien der Quellkopie, relativ zum Ziel-Repo, NUL-getrennt:
# was Git kennt (versioniert oder neu und nicht ignoriert) plus vendor/.
source_files() { # ziel
  local f
  {
    git -C "$1" ls-files -z --cached --others --exclude-standard
    if [ -d "$1/vendor" ]; then
      (cd "$1" && find vendor \( -type f -o -type l \) -print0)
    fi
  } | while IFS= read -r -d '' f; do
    [ -e "$1/$f" ] || [ -L "$1/$f" ] || continue # gelöscht, aber noch versioniert
    is_denied "$f" && continue
    printf '%s\0' "$f"
  done
}

cmd_prepare() {
  local agent_root="" target="" size="512m" rw=() root src scratch p d hit
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent-root) agent_root="${2:-}"; shift 2 ;;
      --target) target="${2:-}"; shift 2 ;;
      --scratch-size) size="${2:-}"; shift 2 ;;
      --rw) check_rel_path "${2:-}"; rw+=("$2"); shift 2 ;;
      *) die 2 "prepare: unbekannte Option $1" ;;
    esac
  done
  [ -n "$agent_root" ] && [ -n "$target" ] || die 2 "prepare braucht --agent-root und --target"
  [[ "$size" =~ ^[0-9]+[mg]$ ]] || die 2 "--scratch-size wie 512m oder 1g angeben: $size"

  root="$(check_agent_root "$agent_root")"
  git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die 3 "--target ist kein Git-Repo: $target"
  target="$(realpath_py "$(git -C "$target" rev-parse --show-toplevel)")"
  [[ "$root/" != "$target"/* ]] || die 3 "--agent-root darf nicht im Ziel-Repo liegen"
  if [ -e "$root" ] && [ -n "$(ls -A "$root")" ]; then
    die 3 "Agent-Root existiert schon und ist nicht leer: $root"
  fi

  src="$root/src"
  scratch="$root/scratch"
  mkdir -p "$src" "$scratch"
  mkdir -m 0700 "$root/artifacts"

  # Scratch: Image fester Grösse, der einzige beschreibbare Ort der Sandbox.
  hdiutil create -quiet -size "$size" -fs APFS -volname sa-scratch -type UDIF "$root/scratch.dmg"
  hdiutil attach -quiet -nobrowse -noautoopen -mountpoint "$scratch" "$root/scratch.dmg"
  chmod 0777 "$scratch"
  for d in $SCRATCH_DIRS; do
    mkdir -m 0777 "$scratch/$d"
  done
  if [ "${#rw[@]}" -gt 0 ]; then
    for p in "${rw[@]}"; do
      [ -d "$target/$p" ] || die 3 "--rw $p ist im Ziel-Repo kein Ordner"
      (cd "$target" && find "$p" -type d -print0) | while IFS= read -r -d '' d; do
        mkdir -p -m 0777 "$scratch/rw/$d"
      done
    done
  fi

  # Quellkopie: ohne ignorierte Dateien und ohne Denylist-Treffer.
  source_files "$target" | (cd "$target" && tar --null -T - -cf -) | (cd "$src" && tar -xf -)
  hit="$(cd "$src" && find . \( -name .git -o -name node_modules -o -name .ddev -o -name .env -o -name '.env.*' \
    -o -name auth.json -o -name '*.key' -o -name '*.pem' \) -print | head -5)"
  if [ -n "$hit" ]; then
    cmd_cleanup --agent-root "$root" >/dev/null 2>&1 || true
    die 3 "Denylist-Treffer in der Quellkopie: $hit"
  fi
  chmod -R a+rX "$src"

  python3 -I -c '
import json, sys
print(json.dumps({"commit": sys.argv[1], "dirty": sys.argv[2] != "", "target": sys.argv[3]}))
' "$(git -C "$target" rev-parse HEAD)" "$(git -C "$target" status --porcelain | head -1)" "$target" >"$root/src.ref.json"

  echo "prepare: $root"
}

cmd_cleanup() {
  local agent_root="" root ids
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent-root) agent_root="${2:-}"; shift 2 ;;
      *) die 2 "cleanup: unbekannte Option $1" ;;
    esac
  done
  [ -n "$agent_root" ] || die 2 "cleanup braucht --agent-root"
  root="$(check_agent_root "$agent_root")"

  if ids="$(docker --context "$DOCKER_CONTEXT" ps -aq --filter "label=security-audit.agent=$(agent_label "$root")" 2>/dev/null)"; then
    [ -z "$ids" ] || docker --context "$DOCKER_CONTEXT" rm -f $ids >/dev/null
  else
    echo "sandbox-run.sh: Warnung: Docker-Kontext $DOCKER_CONTEXT nicht erreichbar, Container nicht geprüft" >&2
  fi
  if is_mounted "$root/scratch"; then
    diskutil eject "$root/scratch" >/dev/null 2>&1 || hdiutil detach -quiet -force "$root/scratch"
  fi
  is_mounted "$root/scratch" && die 3 "scratch/ liess sich nicht aushängen: $root/scratch"
  rm -rf "$root/src" "$root/scratch.dmg"
  [ ! -d "$root/scratch" ] || rmdir "$root/scratch"
  echo "cleanup: $root"
}

[ $# -gt 0 ] || die 2 "Unterbefehl fehlt: prepare | cleanup"
sub="$1"
shift
case "$sub" in
  prepare) cmd_prepare "$@" ;;
  cleanup) cmd_cleanup "$@" ;;
  *) die 2 "unbekannter Unterbefehl: $sub" ;;
esac
