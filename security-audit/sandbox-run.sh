#!/usr/bin/env bash
# Sandbox für den security-audit-Skill.
#
#   sandbox-run.sh prepare --agent-root DIR --target REPO [--scratch-size 512m] [--rw PATH]...
#                          [--include PATH]...
#   sandbox-run.sh exec --agent-root DIR --image IMG --env-file FILE [--pg IMG] [--redis IMG]
#                       [--cpus N] [--memory SIZE] [--pids N] [--fsize SIZE] [--timeout SEK]
#                       [--rw PATH]... [--workdir DIR] [--unverified-for-acceptance] -- BEFEHL...
#   sandbox-run.sh cleanup --agent-root DIR
#   sandbox-run.sh fingerprint
#   sandbox-run.sh label --agent-root DIR     (Wert für promote.py --container-label)
#
# Nur der Parent eines Audit-Laufs ruft dieses Skript auf. Details: README.md.
# Eigene Exit-Codes: 90 Aufruffehler, 91 Vorbedingung verweigert. Sonst gibt
# exec den Exit-Code des Befehls zurück. Die Werte sind hoch gewählt, damit sie
# nicht mit üblichen Codes des Zielcodes (1, 2, 3 …) verwechselt werden.

set -euo pipefail

AUDIT_ROOT="$HOME/security-audit-skill"
DOCKER_CONTEXT="colima-audit"
SCRATCH_DIRS="home tmp cache input out rw"
ACCEPTANCE_FILE="${SANDBOX_ACCEPTANCE_FILE:-$AUDIT_ROOT/.sandbox-acceptance.json}"
SELF="$(cd "$(dirname "$0")" && pwd)/$(basename "$0")"

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
    case "$part" in .git | node_modules | .ddev | .ssh | .aws) return 0 ;; esac
  done
  base="${1##*/}"
  case "$base" in
    .env | .env.* | .env-* | *.env | .envrc | auth.json | .npmrc | .netrc | .pgpass) return 0 ;;
    *.key | *.pem | *.p12 | *.pfx | id_rsa* | id_ecdsa* | id_ed25519* | id_dsa*) return 0 ;;
  esac
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
  [[ "$1" = /* ]] || die 91 "--agent-root muss absolut sein: $1"
  # Komma und Anführungszeichen brechen die Optionen von docker --mount.
  [[ "$1" != *[,\"]* ]] || die 91 "--agent-root darf kein Komma und kein Anführungszeichen enthalten: $1"
  root="$(realpath_py "$1")"
  audit="$(realpath_py "$AUDIT_ROOT")"
  [[ "$root" = "$audit"/?* ]] || die 91 "--agent-root muss unter $AUDIT_ROOT liegen: $1"
  valid_agent_id "$(basename "$root")" || die 91 "ungültige Agent-ID: $(basename "$root")"
  printf '%s\n' "$root"
}

check_rel_path() { # pfad
  case "/$1/" in
    *"/../"* | *"/./"* | *"//"*) die 90 "Pfad muss relativ sein, ohne . und ..: $1" ;;
  esac
  [[ "$1" != /* && -n "$1" ]] || die 90 "Pfad muss relativ sein: $1"
}

# Bricht ab, wenn ein Teil von base/rel ein Symlink oder kein Ordner ist.
# Zielcode kann unter scratch/ Symlinks anlegen. Docker würde ihnen beim
# Bind-Mount folgen.
check_no_symlink() { # base rel
  local path="$1" part IFS=/
  for part in $2; do
    path="$path/$part"
    [ ! -L "$path" ] || die 91 "Symlink in scratch/, Lauf verweigert: $path"
    [ -d "$path" ] || die 91 "kein Ordner: $path"
  done
}

agent_label() { # agent-root
  printf '%s' "$1" | shasum -a 256 | cut -c1-12
}

is_mounted() { # pfad
  mount | grep -qF " on $1 ("
}

# Listet die Dateien der Quellkopie, relativ zum Ziel-Repo, NUL-getrennt:
# was Git kennt (versioniert oder neu und nicht ignoriert), dazu vendor/ und
# jeder weitere Pfad aus --include, auch wenn Git ihn ignoriert.
source_files() { # ziel [include-pfad]...
  local target="$1" f p
  shift
  {
    git -C "$target" ls-files -z --cached --others --exclude-standard
    for p in vendor "$@"; do
      if [ -e "$target/$p" ]; then
        (cd "$target" && find "$p" \( -type f -o -type l \) -print0)
      fi
    done
  } | while IFS= read -r -d '' f; do
    [ -e "$target/$f" ] || [ -L "$target/$f" ] || continue # gelöscht, aber noch versioniert
    if [ -d "$target/$f" ] && [ ! -L "$target/$f" ]; then
      # Ein Ordner in ls-files ist ein Submodul oder eingebettetes Repo.
      echo "sandbox-run.sh: Hinweis: $f ist ein Submodul und fehlt in src/. Bei Bedarf mit --include $f übernehmen." >&2
      continue
    fi
    is_denied "$f" && continue
    printf '%s\0' "$f"
  done
}

cmd_prepare() {
  local agent_root="" target="" size="512m" rw=() includes=() root src scratch p d hit
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent-root) agent_root="${2:-}"; shift 2 ;;
      --target) target="${2:-}"; shift 2 ;;
      --scratch-size) size="${2:-}"; shift 2 ;;
      --rw) check_rel_path "${2:-}"; rw+=("$2"); shift 2 ;;
      --include) check_rel_path "${2:-}"; includes+=("$2"); shift 2 ;;
      *) die 90 "prepare: unbekannte Option $1" ;;
    esac
  done
  [ -n "$agent_root" ] && [ -n "$target" ] || die 90 "prepare braucht --agent-root und --target"
  [[ "$size" =~ ^[0-9]+[mg]$ ]] || die 90 "--scratch-size wie 512m oder 1g angeben: $size"

  root="$(check_agent_root "$agent_root")"
  git -C "$target" rev-parse --is-inside-work-tree >/dev/null 2>&1 || die 91 "--target ist kein Git-Repo: $target"
  target="$(realpath_py "$(git -C "$target" rev-parse --show-toplevel)")"
  [[ "$root/" != "$target"/* ]] || die 91 "--agent-root darf nicht im Ziel-Repo liegen"
  if [ -e "$root" ] && [ -n "$(ls -A "$root")" ]; then
    die 91 "Agent-Root existiert schon und ist nicht leer: $root"
  fi
  if [ "${#rw[@]}" -gt 0 ]; then
    for p in "${rw[@]}"; do
      [ -d "$target/$p" ] && [ ! -L "$target/$p" ] || die 91 "--rw $p ist im Ziel-Repo kein Ordner"
    done
  fi
  if [ "${#includes[@]}" -gt 0 ]; then
    for p in "${includes[@]}"; do
      [ -e "$target/$p" ] || die 91 "--include $p fehlt im Ziel-Repo"
    done
  fi

  # Scheitert prepare ab hier, räumt der Trap alles weg. Ein neuer Versuch auf
  # demselben Agent-Root ist dann möglich.
  trap 'rc=$?; if [ "$rc" -ne 0 ]; then cmd_cleanup --agent-root "$root" >/dev/null 2>&1; rm -rf "$root"; fi' EXIT

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
      (cd "$target" && find "$p" -type d -print0) | while IFS= read -r -d '' d; do
        mkdir -p -m 0777 "$scratch/rw/$d"
      done
    done
  fi

  # Quellkopie: ohne ignorierte Dateien und ohne Denylist-Treffer.
  source_files "$target" ${includes[@]+"${includes[@]}"} | (cd "$target" && tar --null -T - -cf -) | (cd "$src" && tar -xf -)
  hit="$(cd "$src" && find . \( -name .git -o -name node_modules -o -name .ddev -o -name .ssh -o -name .aws \
    -o -name .env -o -name '.env.*' -o -name '.env-*' -o -name '*.env' -o -name .envrc -o -name auth.json \
    -o -name .npmrc -o -name .netrc -o -name .pgpass -o -name '*.key' -o -name '*.pem' -o -name '*.p12' \
    -o -name '*.pfx' -o -name 'id_rsa*' -o -name 'id_ecdsa*' -o -name 'id_ed25519*' -o -name 'id_dsa*' \) \
    -print | head -5 || true)"
  [ -z "$hit" ] || die 91 "Denylist-Treffer in der Quellkopie: $hit"
  chmod -R a+rX "$src"

  python3 -I -c '
import json, sys
print(json.dumps({"commit": sys.argv[1], "dirty": sys.argv[2] != "", "target": sys.argv[3]}))
' "$(git -C "$target" rev-parse HEAD)" "$(git -C "$target" status --porcelain | head -1)" "$target" >"$root/src.ref.json"

  echo "prepare: $root"
}

to_bytes() { # 64m | 1g | 512k | 1024
  local n="${1%[kKmMgG]}" unit="${1##*[0-9]}"
  [[ "$n" =~ ^[0-9]+$ ]] || die 90 "Grösse wie 64m oder 1g angeben: $1"
  case "$unit" in
    "") echo "$n" ;;
    k | K) echo $((n * 1024)) ;;
    m | M) echo $((n * 1024 * 1024)) ;;
    g | G) echo $((n * 1024 * 1024 * 1024)) ;;
  esac
}

# Merkmale der Laufzeit, an die der Abnahme-Nachweis gebunden ist.
cmd_fingerprint() {
  local colima docker_version images mounts sha
  colima="$(colima version 2>/dev/null | awk 'NR==1 {print $3}')"
  docker_version="$(docker --context "$DOCKER_CONTEXT" version --format '{{.Server.Version}}' 2>/dev/null)" ||
    die 91 "Docker-Kontext $DOCKER_CONTEXT nicht erreichbar. Läuft «colima start -p audit»?"
  images="$(docker --context "$DOCKER_CONTEXT" images --no-trunc --format '{{.Repository}}:{{.Tag}} {{.ID}}' | sort)"
  mounts="$(colima ssh -p audit -- findmnt -t virtiofs -n -o TARGET 2>/dev/null | sort)"
  sha="$(shasum -a 256 "$SELF" | cut -d' ' -f1)"
  python3 -I -c '
import json, sys
images = dict(line.split(" ", 1) for line in sys.argv[3].splitlines() if line)
mounts = [m for m in sys.argv[4].splitlines() if m]
print(json.dumps({"colima_version": sys.argv[1], "docker_server_version": sys.argv[2],
                  "images": images, "sandbox_run_sha256": sys.argv[5], "vm_mounts": mounts}, sort_keys=True))
' "$colima" "$docker_version" "$images" "$mounts" "$sha"
}

# Prüft den Nachweis gegen den aktuellen Fingerprint. Gibt bei Abweichung den Grund aus.
proof_mismatch() { # fingerprint-json
  python3 -I -c '
import json, sys
try:
    with open(sys.argv[1]) as f:
        proof = json.load(f)
except (OSError, ValueError) as e:
    print(f"kein gültiger Abnahme-Nachweis unter {sys.argv[1]}: {e}")
    raise SystemExit(0)
if proof.get("result") != "green":
    print("Abnahme-Nachweis ist nicht grün")
    raise SystemExit(0)
fp = json.loads(sys.argv[2])
diff = [k for k in sorted(fp) if proof.get(k) != fp[k]]
if diff:
    print("Abnahme-Nachweis passt nicht mehr, geändert: " + ", ".join(diff))
' "$ACCEPTANCE_FILE" "$1"
}

WATCHDOG=""

stop_watchdog() {
  [ -z "$WATCHDOG" ] || kill "$WATCHDOG" 2>/dev/null || true
}

remove_containers() { # label
  local ids
  ids="$(docker --context "$DOCKER_CONTEXT" ps -aq --filter "label=security-audit.agent=$1" 2>/dev/null)" || return 0
  [ -z "$ids" ] || docker --context "$DOCKER_CONTEXT" rm -f $ids >/dev/null 2>&1 || true
}

cmd_exec() {
  local agent_root="" image="" env_file="" pg="" redis="" cpus=2 memory=1g pids=256 fsize=64m timeout=300
  local workdir=/src unverified=0 rw=() root label fp mismatch line key envs=() keys=" " p
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent-root) agent_root="${2:-}"; shift 2 ;;
      --image) image="${2:-}"; shift 2 ;;
      --env-file) env_file="${2:-}"; shift 2 ;;
      --pg) pg="${2:-}"; shift 2 ;;
      --redis) redis="${2:-}"; shift 2 ;;
      --cpus) cpus="${2:-}"; shift 2 ;;
      --memory) memory="${2:-}"; shift 2 ;;
      --pids) pids="${2:-}"; shift 2 ;;
      --fsize) fsize="${2:-}"; shift 2 ;;
      --timeout) timeout="${2:-}"; shift 2 ;;
      --rw) check_rel_path "${2:-}"; rw+=("$2"); shift 2 ;;
      --workdir) workdir="${2:-}"; shift 2 ;;
      --unverified-for-acceptance) unverified=1; shift ;;
      --) shift; break ;;
      *) die 90 "exec: unbekannte Option $1" ;;
    esac
  done
  [ $# -gt 0 ] || die 90 "exec: Befehl nach -- fehlt"
  [ -n "$agent_root" ] && [ -n "$image" ] && [ -n "$env_file" ] || die 90 "exec braucht --agent-root, --image und --env-file"
  [ -z "$redis" ] || [ -n "$pg" ] || die 90 "--redis braucht --pg, Redis teilt dessen Netz-Namespace"
  [[ "$timeout" =~ ^[0-9]+$ && "$pids" =~ ^[0-9]+$ ]] || die 90 "--timeout und --pids als ganze Zahl angeben"
  [[ "$cpus" =~ ^[0-9]+(\.[0-9]+)?$ ]] || die 90 "--cpus als Zahl angeben: $cpus"
  memory="$(to_bytes "$memory")"
  fsize="$(to_bytes "$fsize")"

  root="$(check_agent_root "$agent_root")"
  [[ "$root" != *,* ]] || die 91 "Agent-Root darf kein Komma enthalten (docker --mount)"
  is_mounted "$root/scratch" || die 91 "scratch/ ist nicht eingehängt. Zuerst «prepare» aufrufen."
  [ -d "$root/src" ] || die 91 "src/ fehlt. Zuerst «prepare» aufrufen."

  fp="$(cmd_fingerprint)"
  python3 -I -c '
import json, sys
mounts = json.loads(sys.argv[1])["vm_mounts"]
raise SystemExit(0 if mounts == [sys.argv[2]] else 1)
' "$fp" "$AUDIT_ROOT" || die 91 "Die Audit-VM hängt mehr oder anderes ein als $AUDIT_ROOT. Siehe README.md."
  if [ "$unverified" = 1 ]; then
    echo "sandbox-run.sh: Warnung: Lauf ohne Abnahme-Nachweis (nur für acceptance.sh)" >&2
  else
    mismatch="$(proof_mismatch "$fp")"
    [ -z "$mismatch" ] || die 91 "$mismatch. Zuerst tests/acceptance.sh laufen lassen."
  fi

  # Jedes Scratch-Image hat als Wurzel dieselbe Inode, und macOS vergibt
  # Disk-Nummern neu. Die VM hält sonst einen veralteten Eintrag für ein
  # früheres Image. Deshalb die Caches der Audit-VM leeren und prüfen.
  colima ssh -p audit -- sudo sh -c 'sync; echo 2 > /proc/sys/vm/drop_caches' ||
    die 91 "Caches der Audit-VM liessen sich nicht leeren"
  colima ssh -p audit -- test -d "$root/scratch/out" -a -d "$root/src" ||
    die 91 "Die Audit-VM sieht scratch/ oder src/ nicht: $root"

  # Leere Umgebung: nur die Schlüssel aus dem env-file, über env -i im Container.
  [ -f "$env_file" ] || die 90 "env-file fehlt: $env_file"
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in "" | "#"*) continue ;; esac
    key="${line%%=*}"
    [[ "$line" = *=* && "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]] || die 90 "env-file: ungültige Zeile: $line"
    case "$key" in
      HOME | TMPDIR | XDG_CACHE_HOME | XDG_CONFIG_HOME | XDG_DATA_HOME | COMPOSER_HOME | COMPOSER_CACHE_DIR)
        [[ "${line#*=}" = /scratch || "${line#*=}" = /scratch/* ]] ||
          die 90 "env-file: $key muss auf /scratch zeigen: ${line#*=}"
        ;;
    esac
    envs+=("$line")
    keys="$keys$key "
  done <"$env_file"
  for key in PATH HOME TMPDIR; do
    [[ "$keys" = *" $key "* ]] || die 90 "env-file: $key fehlt"
  done

  label="$(agent_label "$root")"
  # shellcheck disable=SC2064 # Label jetzt festhalten.
  trap "stop_watchdog; remove_containers '$label'" EXIT
  trap "stop_watchdog; remove_containers '$label'; exit 143" TERM
  trap "stop_watchdog; remove_containers '$label'; exit 130" INT
  remove_containers "$label"

  local harden=(--label "security-audit.agent=$label" --pull never --read-only --cap-drop ALL
    --security-opt no-new-privileges)
  local net=none
  if [ -n "$pg" ]; then
    docker --context "$DOCKER_CONTEXT" run -d --name "sa-$label-pg" "${harden[@]}" --network none \
      --user postgres --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128 \
      --tmpfs /var/lib/postgresql/data:rw,size=256m,uid=999,gid=999,mode=0700 \
      --tmpfs /var/run/postgresql:rw,size=1m,uid=999,gid=999 \
      --tmpfs /tmp:rw,size=16m,uid=999,gid=999 \
      -e POSTGRES_USER=db -e POSTGRES_PASSWORD=db -e POSTGRES_DB=db_test "$pg" >/dev/null
    local i=0
    until docker --context "$DOCKER_CONTEXT" exec "sa-$label-pg" pg_isready -q -h 127.0.0.1 -U db -d db_test 2>/dev/null; do
      i=$((i + 1))
      [ "$i" -le 30 ] || die 91 "Postgres wurde in 30 s nicht bereit"
      sleep 1
    done
    net="container:sa-$label-pg"
  fi
  if [ -n "$redis" ]; then
    docker --context "$DOCKER_CONTEXT" run -d --name "sa-$label-redis" "${harden[@]}" --network "$net" \
      --user redis --cpus 1 --memory 512m --memory-swap 512m --pids-limit 128 \
      --tmpfs /data:rw,size=64m,uid=999,gid=999 \
      "$redis" redis-server --save '' --appendonly no --bind 127.0.0.1 >/dev/null
  fi

  local mounts=(--mount "type=bind,src=$root/src,dst=/src,readonly" --mount "type=bind,src=$root/scratch,dst=/scratch")
  if [ "${#rw[@]}" -gt 0 ]; then
    for p in "${rw[@]}"; do
      check_no_symlink "$root/scratch" "rw/$p"
      [ -d "$root/src/$p" ] || die 91 "--rw $p: Mountpunkt fehlt in src/"
      mounts+=(--mount "type=bind,src=$root/scratch/rw/$p,dst=/src/$p")
    done
  fi

  # Wall-Clock: timeout im Container, dazu ein Wächter auf dem Host.
  # docker run läuft im Hintergrund, damit die Traps sofort greifen.
  # Kein --init: So ist PID 1 der Prozess, den env -i mit leerer Umgebung
  # startet. Mit docker-init zeigte /proc/1/environ die Image-Umgebung.
  local rc=0 child
  docker --context "$DOCKER_CONTEXT" run --name "sa-$label-test" "${harden[@]}" \
    --network "$net" --user 65534:65534 --workdir "$workdir" \
    --cpus "$cpus" --memory "$memory" --memory-swap "$memory" --pids-limit "$pids" \
    --ulimit "fsize=$fsize:$fsize" --ulimit nofile=1024:1024 \
    --env-file "$env_file" "${mounts[@]}" --entrypoint /usr/bin/env \
    "$image" -i "${envs[@]}" timeout --kill-after=5 "$timeout" "$@" </dev/null &
  child=$!
  # Der Wächter beendet bei TERM auch sein sleep. Sonst bliebe es verwaist.
  (
    trap 'kill "$s" 2>/dev/null; exit 0' TERM
    sleep $((timeout + 15)) &
    s=$!
    wait "$s"
    docker --context "$DOCKER_CONTEXT" kill "sa-$label-test" >/dev/null 2>&1
  ) </dev/null >/dev/null 2>&1 &
  WATCHDOG=$!
  wait "$child" || rc=$?
  stop_watchdog
  return "$rc"
}

cmd_label() {
  [ "${1:-}" = "--agent-root" ] && [ -n "${2:-}" ] || die 90 "label braucht --agent-root"
  echo "security-audit.agent=$(agent_label "$(check_agent_root "$2")")"
}

cmd_cleanup() {
  local agent_root="" root ids
  while [ $# -gt 0 ]; do
    case "$1" in
      --agent-root) agent_root="${2:-}"; shift 2 ;;
      *) die 90 "cleanup: unbekannte Option $1" ;;
    esac
  done
  [ -n "$agent_root" ] || die 90 "cleanup braucht --agent-root"
  root="$(check_agent_root "$agent_root")"

  if ids="$(docker --context "$DOCKER_CONTEXT" ps -aq --filter "label=security-audit.agent=$(agent_label "$root")" 2>/dev/null)"; then
    [ -z "$ids" ] || docker --context "$DOCKER_CONTEXT" rm -f $ids >/dev/null
  else
    echo "sandbox-run.sh: Warnung: Docker-Kontext $DOCKER_CONTEXT nicht erreichbar, Container nicht geprüft" >&2
  fi
  if is_mounted "$root/scratch"; then
    diskutil eject "$root/scratch" >/dev/null 2>&1 || hdiutil detach -quiet -force "$root/scratch"
  fi
  is_mounted "$root/scratch" && die 91 "scratch/ liess sich nicht aushängen: $root/scratch"
  rm -rf "$root/src" "$root/scratch.dmg"
  [ ! -d "$root/scratch" ] || rmdir "$root/scratch"
  echo "cleanup: $root"
}

[ $# -gt 0 ] || die 90 "Unterbefehl fehlt: prepare | exec | cleanup | fingerprint | label"
sub="$1"
shift
case "$sub" in
  prepare) cmd_prepare "$@" ;;
  exec) cmd_exec "$@" ;;
  cleanup) cmd_cleanup "$@" ;;
  fingerprint) cmd_fingerprint ;;
  label) cmd_label "$@" ;;
  *) die 90 "unbekannter Unterbefehl: $sub" ;;
esac
