#!/usr/bin/env bash
#
# Richtet eine frische Ubuntu-24.04-VM als GitHub-Actions-Runner-Host ein.
# Einmal als ubuntu-User mit sudo ausführen. Das Skript ist idempotent:
# ein zweiter Lauf überspringt, was schon da ist.
#
# Was danach vorhanden ist:
#   - 2 GB Swap
#   - Docker (für services:-Container wie postgres/redis)
#   - PHP 8.3 und 8.4 CLI mit den Extensions der Quality-Workflows
#   - composer, git, curl, jq, unzip
#   - User "runner" (kein sudo, Mitglied der docker-Gruppe)
#
# Node fehlt absichtlich: actions/setup-node installiert es je Lauf in den
# Runner-Tool-Cache und respektiert .nvmrc.

set -euo pipefail

if [[ $EUID -ne 0 ]]; then
  echo "Mit sudo ausführen: sudo $0" >&2
  exit 1
fi

echo "==> Swap (2 GB)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' >>/etc/fstab
fi

echo "==> Basispakete"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
# shellcheck: auf GitHub-Hosted-Runnern vorinstalliert, hier nicht. Der
# mautic-Workflow ruft es direkt auf und scheitert sonst am fehlenden Befehl.
apt-get install -y -qq git curl jq unzip ca-certificates software-properties-common shellcheck

echo "==> Docker"
if ! command -v docker >/dev/null; then
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] \
https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
    >/etc/apt/sources.list.d/docker.list
  apt-get update -qq
  apt-get install -y -qq docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi

echo "==> PHP 8.3 + 8.4"
add-apt-repository -y ppa:ondrej/php >/dev/null
apt-get update -qq
# Extensions aus den Quality-Workflows (pdo_pgsql steckt im pgsql-Paket).
# xml und curl dazu: composer und Laravel brauchen beide.
for v in 8.3 8.4; do
  apt-get install -y -qq \
    "php${v}-cli" "php${v}-pgsql" "php${v}-redis" "php${v}-intl" \
    "php${v}-mbstring" "php${v}-bcmath" "php${v}-zip" "php${v}-gd" \
    "php${v}-xml" "php${v}-curl"
done
update-alternatives --set php /usr/bin/php8.4

echo "==> PostgreSQL-Client 17 + redis-tools"
# Auch das ist auf ubuntu-latest vorinstalliert: Laravel lädt den
# Schema-Dump (database/schema/*.sql) über psql statt über Migrationen.
# Fehlt psql, scheitert jeder Test, der eine Datenbank anfasst — mit
# "sh: 1: psql: not found" tief in einer ProcessFailedException.
# Aus dem PGDG-Repo, damit der Client zur Server-Version 17 passt.
if ! command -v psql >/dev/null; then
  install -d /usr/share/postgresql-common/pgdg
  curl -fsSL -o /usr/share/postgresql-common/pgdg/apt.postgresql.org.asc \
    https://www.postgresql.org/media/keys/ACCC4CF8.asc
  echo "deb [signed-by=/usr/share/postgresql-common/pgdg/apt.postgresql.org.asc] \
https://apt.postgresql.org/pub/repos/apt $(. /etc/os-release && echo "$VERSION_CODENAME")-pgdg main" \
    >/etc/apt/sources.list.d/pgdg.list
  apt-get update -qq
fi
apt-get install -y -qq postgresql-client-17 redis-tools

echo "==> composer"
if ! command -v composer >/dev/null; then
  EXPECTED=$(curl -fsSL https://composer.github.io/installer.sig)
  curl -fsSL https://getcomposer.org/installer -o /tmp/composer-setup.php
  echo "${EXPECTED}  /tmp/composer-setup.php" | sha384sum -c - >/dev/null
  php /tmp/composer-setup.php --quiet --install-dir=/usr/local/bin --filename=composer
  rm /tmp/composer-setup.php
fi

echo "==> User runner"
if ! id runner >/dev/null 2>&1; then
  useradd --create-home --shell /bin/bash runner
fi
usermod -aG docker runner

# Passwortloses sudo ist Voraussetzung, nicht Bequemlichkeit: GitHub-Hosted-
# Runner geben ihrem Job-User genau das, und Actions verlassen sich darauf.
# shivammathur/setup-php etwa legt sein Lock-Verzeichnis per sudo an — ohne
# sudo scheitert es nicht, sondern wartet endlos, und der Job hängt bis zum
# Timeout. Das kostet nichts an Sicherheit: wer einen PR schreiben kann,
# führt hier ohnehin eigenen Code aus (Tests, Build, composer-Scripts). Die
# Schutzgrenze ist, dass nur private Repos ohne Fork-PRs hier laufen.
echo "runner ALL=(ALL) NOPASSWD:ALL" >/etc/sudoers.d/runner
chmod 0440 /etc/sudoers.d/runner
visudo -c -f /etc/sudoers.d/runner >/dev/null

echo "==> Docker-Aufräum-Cron (wöchentlich)"
cat >/etc/cron.weekly/docker-prune <<'EOF'
#!/bin/sh
docker system prune -af --filter "until=168h" >/dev/null 2>&1
EOF
chmod +x /etc/cron.weekly/docker-prune

# Verwaiste Service-Container: Bricht ein Job ab, räumt der Runner seine
# services:-Container nicht immer weg. Auf GitHub-Hosted fällt die ganze VM
# danach weg, hier bleiben sie laufen — mit belegten Ports, an denen der
# nächste Lauf schon beim "Initialize containers" scheitert.
# Stündlich, Grenze 6 h: kein Job dieser Repos läuft länger (Timeout 45 min),
# und auf dieser VM laufen ausschliesslich Runner-Container.
cat >/etc/cron.hourly/runner-stale-containers <<'EOF'
#!/bin/sh
now=$(date +%s)
docker ps -q | while read -r id; do
  started=$(docker inspect -f '{{.State.StartedAt}}' "$id" 2>/dev/null) || continue
  ts=$(date -d "$started" +%s 2>/dev/null) || continue
  [ $((now - ts)) -gt 21600 ] && docker rm -f "$id" >/dev/null 2>&1
done
EOF
chmod +x /etc/cron.hourly/runner-stale-containers

echo "Fertig. Nächster Schritt: runner/register.sh je Repository."
