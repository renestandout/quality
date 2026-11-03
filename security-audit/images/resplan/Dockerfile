# Image für Sandbox-Läufe in resplan (Node 24, pnpm).
# Baut nur build-resplan.sh. Der Kontext enthält nur package.json und
# pnpm-lock.yaml aus resplan, keine Quellen und keine .env.
#
# Die Abhängigkeiten liegen unter /node_modules. Node und Vite suchen von /src
# aus in den Ordnern darüber und finden sie dort, auch bei ESM-import.
# NODE_PATH wirkt nur bei require und wird deshalb nicht gesetzt.
FROM node:24-alpine@sha256:8a32c8cf649a49915a66e81e7a609223c708d0adabf288ee3f4077d765542f85

# coreutils: sandbox-run.sh ruft «timeout --kill-after». Busybox kennt die
# lange Option nicht. git: pnpm holt @standout/quality von GitHub.
RUN apk add --no-cache coreutils git \
  && npm install -g pnpm@9.12.0 \
  && npm cache clean --force

WORKDIR /deps
COPY package.json pnpm-lock.yaml ./
# Standard-Linker wie in resplan selbst. Seine Symlinks zeigen relativ in
# node_modules/.pnpm und bleiben nach dem Verschieben gültig.
RUN pnpm install --frozen-lockfile \
  && mv /deps/node_modules /node_modules \
  && rm -rf /deps /root/.local/share/pnpm /root/.cache \
  && chmod -R a+rX /node_modules

WORKDIR /src
