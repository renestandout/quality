#!/usr/bin/env bash
#
# Registriert eine GitHub-Actions-Runner-Instanz für EIN Repository und
# installiert sie als systemd-Service. Läuft auf der Runner-VM, mit sudo.
#
#   sudo RUNNER_TOKEN=<token> ./register.sh <owner/repo> [instanz-nr]
#
# Das Registrierungs-Token ist 1 Stunde gültig. Vom Arbeitsrechner holen:
#
#   gh api -X POST repos/<owner/repo>/actions/runners/registration-token -q .token
#
# Persönliche Accounts kennen keine Org-Runner — deshalb je Repository eine
# eigene Instanz. Mehrere Instanzen desselben Repos (instanz-nr 1, 2, …)
# erlauben parallele Jobs.

set -euo pipefail

RUNNER_VERSION="2.328.0"

if [[ $EUID -ne 0 ]]; then
  echo "Mit sudo ausführen." >&2
  exit 1
fi
if [[ $# -lt 1 || -z "${RUNNER_TOKEN:-}" ]]; then
  echo "Aufruf: sudo RUNNER_TOKEN=<token> $0 <owner/repo> [instanz-nr]" >&2
  exit 1
fi

REPO="$1"
NR="${2:-1}"
NAME="$(basename "$REPO")"
DIR="/opt/gh-runner/${NAME}/${NR}"
HOSTNAME_SHORT="$(hostname -s)"

if [[ -f "$DIR/.runner" ]]; then
  echo "In $DIR ist schon ein Runner registriert." >&2
  exit 1
fi

echo "==> Runner-Software v${RUNNER_VERSION} nach $DIR"
mkdir -p "$DIR"
TARBALL="actions-runner-linux-x64-${RUNNER_VERSION}.tar.gz"
if [[ ! -f "/opt/gh-runner/${TARBALL}" ]]; then
  curl -fsSL -o "/opt/gh-runner/${TARBALL}" \
    "https://github.com/actions/runner/releases/download/v${RUNNER_VERSION}/${TARBALL}"
fi
tar -xzf "/opt/gh-runner/${TARBALL}" -C "$DIR"
chown -R runner:runner "$DIR"

echo "==> Registrieren bei github.com/${REPO}"
sudo -u runner bash -c "cd '$DIR' && ./config.sh \
  --url 'https://github.com/${REPO}' \
  --token '${RUNNER_TOKEN}' \
  --name '${HOSTNAME_SHORT}-${NAME}-${NR}' \
  --labels 'self-hosted,linux,x64' \
  --unattended --replace"

echo "==> systemd-Service"
cd "$DIR"
./svc.sh install runner
./svc.sh start

echo "Fertig: ${HOSTNAME_SHORT}-${NAME}-${NR} für ${REPO} läuft."
