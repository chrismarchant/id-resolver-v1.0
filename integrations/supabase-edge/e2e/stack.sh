#!/usr/bin/env bash
# Local Supabase stack for the idr-sync end-to-end harness (see README.md).
# LOCAL ONLY: never points at a hosted project. Every secret is generated into
# the work directory (outside the repository) on first use and never printed.
#
#   stack.sh pull    pre-pull the stack images from E2E_IMAGE_MIRROR and tag them
#                    with the names the Supabase CLI expects (optional)
#   stack.sh up      (re)create the local project and start db, auth, rest, kong
#                    and edge-runtime; apply sql/0001_idr_projection.sql
#   stack.sh down    stop the stack and delete its volumes and network
#   stack.sh status  show the containers
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "$HERE/.." && pwd)"
WORK="${E2E_WORK:-${TMPDIR:-/tmp}/idr-supabase-e2e}"
PROJ="$WORK/project"
SUPABASE="${SUPABASE_CLI:-supabase}"
NET="${E2E_DOCKER_NETWORK:-idr_e2e_net}"
PROJECT_ID="idr-e2e"
PROXY_PORT="${E2E_PROXY_PORT:-54380}"
# Services the harness does not use (also disabled in config.toml, so their images are not pulled).
EXCLUDE="realtime,storage-api,imgproxy,mailpit,postgres-meta,studio,logflare,vector,supavisor"
# Images that Supabase CLI 3.0.0 runs for the services above that stay enabled.
IMAGES=(
  "supabase/postgres:17.11.0.011"
  "supabase/gotrue:v2.197.0"
  "postgrest/postgrest:v16.5"
  "library/kong:2.8.1"
  "supabase/edge-runtime:v1.77.9"
)
export DO_NOT_TRACK=1 SUPABASE_TELEMETRY_DISABLED=1

mkdir -p "$WORK"
chmod 700 "$WORK"

secrets() {
  local f="$WORK/secrets.env"
  if [ ! -f "$f" ]; then
    (umask 077; {
      echo "IDR_E2E_JWT_SECRET=$(openssl rand -hex 32)"
      echo "E2E_SYNC_SECRET=$(openssl rand -hex 32)"
      echo "E2E_REPORTING_TOKEN=$(openssl rand -hex 32)"
      echo "E2E_RESOLVER_TOKEN=$(openssl rand -hex 32)"
      echo "E2E_IP_HMAC_SECRET=$(openssl rand -hex 32)"
      echo "E2E_IP_HMAC_SECRET_ROTATED=$(openssl rand -hex 32)"
    } > "$f")
  fi
  set -a
  # shellcheck disable=SC1090
  . "$f"
  set +a
}

cli() { "$SUPABASE" --workdir "$PROJ" "$@"; }

gateway() {
  docker network inspect -f '{{range .IPAM.Config}}{{.Gateway}}{{end}}' "$NET"
}

cmd_pull() {
  local mirror="${E2E_IMAGE_MIRROR:?set E2E_IMAGE_MIRROR (for example mirror.gcr.io)}"
  for img in "${IMAGES[@]}"; do
    docker pull "$mirror/$img"
    docker tag "$mirror/$img" "public.ecr.aws/supabase/${img##*/}"
  done
}

cmd_up() {
  secrets
  command -v "$SUPABASE" >/dev/null || { echo "Supabase CLI not found (set SUPABASE_CLI)" >&2; exit 1; }
  docker info >/dev/null
  if [ -f "$PROJ/supabase/config.toml" ]; then cli stop --no-backup >/dev/null 2>&1 || true; fi
  # Published ports of this network bind to 127.0.0.1 only (the CLI publishes with no host IP).
  if ! docker network inspect "$NET" >/dev/null 2>&1; then
    docker network create -o com.docker.network.bridge.host_binding_ipv4=127.0.0.1 "$NET" >/dev/null
  fi
  local gw
  gw="$(gateway)"
  [ -n "$gw" ] || { echo "no gateway address on docker network $NET" >&2; exit 1; }

  rm -rf "$PROJ"
  mkdir -p "$PROJ"
  (cd "$PROJ" && "$SUPABASE" init --yes >/dev/null)
  node "$HERE/lib/configure-project.mjs" "$PROJ/supabase/config.toml" "$PKG/supabase/config.toml" "$PROJECT_ID"
  # SETUP.md step 3: place the function and src/core so ../../../src/core/index.ts resolves.
  mkdir -p "$PROJ/supabase/functions/idr-sync" "$PROJ/src/core"
  cp "$PKG/supabase/functions/idr-sync/index.ts" "$PROJ/supabase/functions/idr-sync/index.ts"
  cp "$PKG"/src/core/*.ts "$PROJ/src/core/"
  # Function secrets (SETUP.md step 2). The base URL is the harness fault proxy on
  # this network's gateway, which forwards to the resolver on 127.0.0.1.
  (umask 077; cat > "$PROJ/supabase/functions/.env") <<EOF
IDR_BASE_URL=http://$gw:$PROXY_PORT
IDR_REPORTING_TOKEN=$E2E_REPORTING_TOKEN
IDR_INSTALLATION_ID=idr-e2e
IDR_SYNC_SECRET=$E2E_SYNC_SECRET
IDR_ALLOW_INSECURE_HTTP=true
IDR_PAGE_LIMIT=5
IDR_MAX_PAGES=50
IDR_BUDGET_MS=30000
IDR_REQUEST_TIMEOUT_MS=5000
IDR_MAX_RETRIES=2
IDR_BACKOFF_BASE_MS=20
IDR_BACKOFF_MAX_MS=100
EOF
  cli start --network-id "$NET" -x "$EXCLUDE" > "$WORK/start.log" 2>&1 || { tail -n 20 "$WORK/start.log" >&2; exit 1; }
  (umask 077; cli status -o json 2>/dev/null > "$WORK/status.json")
  local db_url
  db_url="$(node -e 'process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).DB_URL)' "$WORK/status.json")"
  # SETUP.md step 1: apply the projection SQL as one script.
  PGOPTIONS="--client-min-messages=warning" psql "$db_url" -v ON_ERROR_STOP=1 -q -f "$PKG/sql/0001_idr_projection.sql"
  echo "stack up: project $PROJECT_ID, network $NET (gateway $gw), work dir $WORK"
}

cmd_down() {
  secrets
  if [ -f "$PROJ/supabase/config.toml" ]; then cli stop --no-backup || true; fi
  docker network rm "$NET" >/dev/null 2>&1 || true
}

cmd_status() {
  docker ps -a --filter "name=_${PROJECT_ID}" --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'
}

case "${1:-}" in
  pull) cmd_pull ;;
  up) cmd_up ;;
  down) cmd_down ;;
  status) cmd_status ;;
  *) echo "usage: $0 pull|up|down|status" >&2; exit 2 ;;
esac
