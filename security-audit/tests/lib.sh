# Kleine Test-Hilfen für die Shell-Tests der Sandbox.
# Jeder Fall ist eine Funktion. run_case führt ihn aus und zählt das Ergebnis.

PASSED=0
FAILED=0
FAILED_NAMES=""

fail() {
  echo "    $*" >&2
  return 1
}

assert_eq() { # erwartet tatsächlich [text]
  [ "$1" = "$2" ] || fail "erwartet «$1», erhalten «$2» ${3:-}"
}

assert_contains() { # text muster
  case "$1" in *"$2"*) return 0 ;; esac
  fail "«$2» fehlt in: $(printf '%s' "$1" | head -c 600)"
}

assert_not_contains() { # text muster
  case "$1" in *"$2"*) fail "«$2» darf nicht vorkommen in: $(printf '%s' "$1" | head -c 600)" ;; esac
  return 0
}

assert_exit() { # erwarteter-code befehl...
  local want="$1" got=0
  shift
  "$@" >/dev/null 2>&1 || got=$?
  [ "$want" = "$got" ] || fail "Exit $got statt $want: $*"
}

# set -e wirkt nicht hinter if, || oder &&. Deshalb läuft der Fall allein in
# einer Subshell, und $? wird erst in der nächsten Zeile gelesen.
# Das Testskript selbst darf deshalb kein set -e setzen.
run_case() { # name
  local rc
  ( set -e; "$1" )
  rc=$?
  if [ "$rc" -eq 0 ]; then
    PASSED=$((PASSED + 1))
    echo "ok      $1"
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES="$FAILED_NAMES $1"
    echo "FEHLER  $1"
  fi
}

finish() {
  echo "-- $PASSED ok, $FAILED Fehler${FAILED_NAMES:+:$FAILED_NAMES}"
  [ "$FAILED" -eq 0 ]
}
