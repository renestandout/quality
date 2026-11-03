#!/usr/bin/env bash
# Probelauf für resplan: Migrationen gegen die Sandbox-MariaDB, danach zwei
# bestehende vitest-Tests. Nur Dummy-Daten.
# Braucht einen gültigen Abnahme-Nachweis (tests/acceptance.sh).

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
SA="$HERE/.."
TARGET="${RESPLAN_TARGET:-$HOME/projects/resplan}"
ROOT="$HOME/security-audit-skill/_probe-resplan/run-1/agents/probe"

"$SA/sandbox-run.sh" cleanup --agent-root "$ROOT" >/dev/null 2>&1 || true
rm -rf "$ROOT"
"$SA/sandbox-run.sh" prepare --agent-root "$ROOT" --target "$TARGET"
trap '"$SA/sandbox-run.sh" cleanup --agent-root "$ROOT" >/dev/null' EXIT

# Keine .env-Datei und kein node_modules in der Quellkopie.
leaks="$(find "$ROOT/src" \( -name '.env*' -o -name node_modules \) | head -3)"
[ -z "$leaks" ] || { echo "probe: verbotene Datei in der Quellkopie: $leaks" >&2; exit 1; }

cat >"$ROOT/manifest.json" <<'JSON'
{"max_total_bytes": 1048576, "files": [
  {"path": "out/migrate.log", "max_bytes": 65536}, {"path": "out/junit.xml", "max_bytes": 1048576}]}
JSON

# Ein Lauf, ein Container-Satz: Migrationen und Tests teilen sich dieselbe MariaDB.
# tsx ohne --env-file: Die Umgebung kommt aus env/resplan.env.
label="$("$SA/sandbox-run.sh" label --agent-root "$ROOT")"
report="$(python3 -I "$SA/promote.py" --scratch "$ROOT/scratch" --artifacts "$ROOT/artifacts" \
  --manifest "$ROOT/manifest.json" --container-label "$label" -- \
  "$SA/sandbox-run.sh" exec --agent-root "$ROOT" \
  --image resplan-audit-built --mariadb mariadb:11 --env-file "$SA/env/resplan.env" -- \
  sh -c 'node /node_modules/tsx/dist/cli.mjs src/db/migrate.ts >/scratch/out/migrate.log 2>&1 || exit 1
    node /node_modules/vitest/vitest.mjs run --reporter=junit --outputFile=/scratch/out/junit.xml \
      src/middleware.test.ts src/lib/auth/guards.test.ts')"
echo "$report"

grep -q "Migrations applied." "$ROOT/artifacts/out/migrate.log" ||
  { echo "probe: Migrationen nicht durchgelaufen:" >&2; cat "$ROOT/artifacts/out/migrate.log" >&2; exit 1; }
echo "probe: Migrationen angewendet"

python3 -I - "$ROOT/artifacts/out/junit.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
suites = [root] if root.tag == "testsuite" else root.findall("testsuite")
tests, failures, errors = (sum(int(s.get(k, 0)) for s in suites) for k in ("tests", "failures", "errors"))
print(f"probe: {tests} Tests, {failures} Fehlschläge, {errors} Fehler")
raise SystemExit(0 if tests > 0 and failures == 0 and errors == 0 else 1)
PY

# Teil 2: ein eigener Prüftest unter scratch/input/, wie ihn ein Verifier
# schreibt. Eigener Agent-Root, weil jeder Root nur eine Übernahme erlaubt.
"$SA/sandbox-run.sh" cleanup --agent-root "$ROOT" >/dev/null
ROOT="$HOME/security-audit-skill/_probe-resplan/run-1/agents/input"
"$SA/sandbox-run.sh" cleanup --agent-root "$ROOT" >/dev/null 2>&1 || true
rm -rf "$ROOT"
"$SA/sandbox-run.sh" prepare --agent-root "$ROOT" --target "$TARGET" 2>/dev/null

# Eigene vitest-Konfiguration: Wurzel scratch/input, Alias @ wie in resplan.
cat >"$ROOT/scratch/input/vitest.config.mjs" <<'JS'
import { defineConfig } from "vitest/config";
export default defineConfig({
  esbuild: { jsx: "automatic" },
  resolve: { alias: { "@": "/src/src" } },
  test: { root: "/scratch/input", include: ["**/*.test.ts"], environment: "node" },
});
JS
cat >"$ROOT/scratch/input/probe.test.ts" <<'TS'
import { expect, test, vi } from "vitest";
import mysql from "mysql2/promise";

vi.mock("@/lib/auth/edge", () => ({ edgeAuth: (handler: unknown) => handler }));
import middleware from "@/middleware";

test("Zielcode über @ und MariaDB über DATABASE_URL erreichbar", async () => {
  expect(typeof middleware).toBe("function");
  const c = await mysql.createConnection(process.env.DATABASE_URL!);
  const [rows] = await c.query("SELECT 1 + 1 AS n");
  expect(rows).toEqual([{ n: 2 }]);
  await c.end();
});
TS
cat >"$ROOT/manifest.json" <<'JSON'
{"max_total_bytes": 1048576, "files": [{"path": "out/junit.xml", "max_bytes": 1048576}]}
JSON

# Vite bündelt die Konfiguration nach node_modules/.vite-temp im nächsten
# node_modules. Von scratch/input aus wäre das /node_modules, das nur lesbar
# ist. Ein leerer Ordner scratch/input/node_modules lenkt es nach scratch/.
label="$("$SA/sandbox-run.sh" label --agent-root "$ROOT")"
report="$(python3 -I "$SA/promote.py" --scratch "$ROOT/scratch" --artifacts "$ROOT/artifacts" \
  --manifest "$ROOT/manifest.json" --container-label "$label" -- \
  "$SA/sandbox-run.sh" exec --agent-root "$ROOT" \
  --image resplan-audit-built --mariadb mariadb:11 --env-file "$SA/env/resplan.env" -- \
  sh -c 'mkdir -p /scratch/input/node_modules &&
    node /node_modules/vitest/vitest.mjs run --config /scratch/input/vitest.config.mjs \
      --reporter=junit --outputFile=/scratch/out/junit.xml')"
echo "$report"

python3 -I - "$ROOT/artifacts/out/junit.xml" <<'PY'
import sys
import xml.etree.ElementTree as ET

root = ET.parse(sys.argv[1]).getroot()
suites = [root] if root.tag == "testsuite" else root.findall("testsuite")
tests, failures, errors = (sum(int(s.get(k, 0)) for s in suites) for k in ("tests", "failures", "errors"))
print(f"probe (scratch/input): {tests} Tests, {failures} Fehlschläge, {errors} Fehler")
raise SystemExit(0 if tests > 0 and failures == 0 and errors == 0 else 1)
PY
