#!/usr/bin/env bash
# Baut das Image resplan-audit-built im Colima-Profil default und kopiert es
# zusammen mit mariadb:11 ins Profil audit.
# Einziger Schritt mit Netz. Nie während eines Audit-Laufs aufrufen.
#
#   security-audit/images/build-resplan.sh [RESPLAN-REPO]

set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
TARGET="${1:-$HOME/projects/resplan}"
IMAGE="resplan-audit-built"
MARIADB="mariadb:11"
MARIADB_DIGEST="sha256:f16d7a344413e519dff518f27bdb221388f84b0d274c97c4fb5f2cb0dc1b34fa"

ctx="$(mktemp -d)"
trap 'rm -rf "$ctx"' EXIT

# Nur Manifest und Lockfile in den Kontext. Keine Quellen, keine .env, keine .npmrc.
cp "$HERE/resplan/Dockerfile" "$ctx/"
git -C "$TARGET" show HEAD:package.json >"$ctx/package.json"
git -C "$TARGET" show HEAD:pnpm-lock.yaml >"$ctx/pnpm-lock.yaml"
echo "build-resplan: Lockfile aus $(git -C "$TARGET" rev-parse --short HEAD)"

docker --context colima build -t "$IMAGE" "$ctx"

# mariadb:11 muss genau der gepinnte Stand sein.
docker --context colima pull "mariadb@$MARIADB_DIGEST" >/dev/null
docker --context colima tag "mariadb@$MARIADB_DIGEST" "$MARIADB"

for i in "$IMAGE" "$MARIADB"; do
  docker --context colima save "$i" | docker --context colima-audit load
done
