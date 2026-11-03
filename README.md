# ID Resolver V1

A lightweight, dedicated-client IP-to-company resolution service and its
integrations:

| Path | What | Status |
|---|---|---|
| `apps/resolver` | Railway service: authenticated ingress, transient IP handling, HMAC fingerprint cache, Enrich provider with spend controls and kill switches, company activity register, read-only reporting API | Baseline imported from V0.1 (provenance in [docs/PROVENANCE.md](docs/PROVENANCE.md)); V1 changes in progress |
| `packages/*` | TanStack Start server adapter (npm) and optional browser collector | Planned (Gate 4) |
| `integrations/*` | Reference Supabase Edge Function adapter and projection SQL template for client Insights environments | Planned (Gate 3) |

Deployment model: **one client website → one dedicated Railway project → one
client Insights/Supabase environment.** It is not a multi-tenant service. See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Development

Requires Node.js 22 and a local PostgreSQL 16 for the integration tests.

```sh
npm ci --ignore-scripts
npm run check:public-safety
export TEST_DATABASE_URL=postgres://resolver:resolver@127.0.0.1:5432/id_resolver_test
npm run verify --workspace @idr/resolver
```

Paid provider calls are off by default (`PROVIDER_MODE=disabled`). Tests use a
mock provider and synthetic data only.

## Licence

Proprietary. All rights reserved. The source is visible for review during
development; no licence is granted.
