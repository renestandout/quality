#!/usr/bin/env bash
# Probelauf: ein bestehender rankscan-Feature-Test in der Sandbox, nur mit Dummy-Daten.
# Braucht einen gültigen Abnahme-Nachweis (tests/acceptance.sh).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SA="$HERE/.."
TARGET="${RANKSCAN_TARGET:-$HOME/projects/rankscan/application}"
TEST_FILE="tests/Feature/Middleware/EnsureUserIsAdminTest.php"
ROOT="$HOME/security-audit-skill/_probe-rankscan/run-1/agents/probe"

"$SA/sandbox-run.sh" cleanup --agent-root "$ROOT" >/dev/null 2>&1 || true
rm -rf "$ROOT"
"$SA/sandbox-run.sh" prepare --agent-root "$ROOT" --target "$TARGET" --rw storage --rw bootstrap/cache --include public/build
trap '"$SA/sandbox-run.sh" cleanup --agent-root "$ROOT" >/dev/null' EXIT

# Keine .env-Datei in der Quellkopie, auch nicht aus vendor/.
leaks="$(find "$ROOT/src" -name '.env*' | head -3)"
[ -z "$leaks" ] || { echo "probe: .env in der Quellkopie: $leaks" >&2; exit 1; }

cat >"$ROOT/manifest.json" <<'JSON'
{"max_total_bytes": 1048576, "files": [{"path": "out/junit.xml", "max_bytes": 1048576}]}
JSON

label="$(printf '%s' "$ROOT" | shasum -a 256 | cut -c1-12)"
report="$(python3 -I "$SA/promote.py" --scratch "$ROOT/scratch" --artifacts "$ROOT/artifacts" \
  --manifest "$ROOT/manifest.json" --container-label "security-audit.agent=$label" -- \
  "$SA/sandbox-run.sh" exec --agent-root "$ROOT" \
  --image ddev/ddev-webserver:v1.25.4-rankscan-built --pg postgres:17-rankscan-built \
  --env-file "$SA/env/rankscan.env" --rw storage --rw bootstrap/cache -- \
  php vendor/bin/phpunit --do-not-cache-result --log-junit /scratch/out/junit.xml "$TEST_FILE")"
echo "$report"

python3 -I - "$ROOT/artifacts/out/junit.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

suite = ET.parse(sys.argv[1]).getroot()
s = suite if suite.tag == "testsuite" else suite.find("testsuite")
tests, failures, errors = (int(s.get(k, 0)) for k in ("tests", "failures", "errors"))
print(f"probe: {tests} Tests, {failures} Fehlschläge, {errors} Fehler")
raise SystemExit(0 if tests > 0 and failures == 0 and errors == 0 else 1)
PY
