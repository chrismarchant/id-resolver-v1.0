#!/bin/sh
# Container entrypoint for ID Resolver V1.
# Refuses debugging settings that would expose memory or an inspector,
# then replaces this shell with the CMD.
set -eu

# Disable core dumps for this process tree. Some platforms refuse to change
# the limit, so failure is tolerated. The kernel core_pattern is host-controlled,
# so this is a best-effort control, not a guarantee.
ulimit -c 0 || true

case "${NODE_OPTIONS:-} $*" in
  *--inspect*|*--heapsnapshot*|*--heap-prof*|*--cpu-prof*|*--prof*|*--report-*|*--diagnostic-dir*)
    echo "refusing to start: inspector, profiler or diagnostic flags are set in NODE_OPTIONS or the command" >&2
    exit 1
    ;;
esac

if [ "${NODE_DEBUG+set}" = "set" ]; then
  echo "refusing to start: NODE_DEBUG is set" >&2
  exit 1
fi

# V1: migrations are NOT applied at startup. They run as a separate deploy
# pre-step (.railway/railway.ts preDeploy: node dist/db/migrate.js), which is
# advisory-locked and fails the deployment if a migration fails. The service
# itself refuses to start while the database has pending migrations.

exec "$@"
