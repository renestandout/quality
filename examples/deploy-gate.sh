#!/usr/bin/env bash
# Baustein für ein Deploy-Skript: nur ausliefern, was das Gate bestanden hat.
#
# Gehört direkt hinter die Prüfung, dass HEAD gleich origin/main ist und das
# Arbeitsverzeichnis sauber. Erst dann ist der geprüfte Commit auch der, der
# gebaut wird.
#
# Ein --force des Skripts darf dieses Gate nicht übergehen. Für den Notfall
# gibt es QUALITY_DEPLOY_OVERRIDE="<Begründung>".
set -euo pipefail

# Pfad zum Paket: node_modules/.bin/quality (npm) oder vendor/bin/quality (Composer).
QUALITY="${QUALITY:-node_modules/.bin/quality}"

# --wait: Direkt nach dem Push läuft CI noch. Das Skript wartet, statt abzubrechen.
if ! GATE_LINE=$("$QUALITY" deploy-check HEAD --wait 900); then
  echo "Deploy abgebrochen: Das Quality-Gate ist auf diesem Commit nicht grün." >&2
  exit 1
fi
echo "$GATE_LINE"

# Die Zeile ins Versionslabel, Log oder in die Tag-Nachricht übernehmen, z.B.:
#   git tag -a "$VERSION" -m "$GATE_LINE"
