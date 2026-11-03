# Source provenance

ID Resolver V1 starts from a selective import of the Signals Resolver V0.1
source. That project is separate, and it is neither modified nor deployed by
this repository.

| Item | Value |
|---|---|
| Source | Signals Resolver V0.1 (`chrismarchant/signals-resolver-v0.1`, formerly `id-resolver-v0.1`) |
| Commit | `b3e4f57c5fa102ce5d0816819f4a5715db81db97` (branch `claude/id-resolver-v0.1-xes66s`) |
| Verification | The supplied source archive was diffed against `git archive` of that commit: tree-identical |
| Baseline at source commit | typecheck clean; 20 test files / 368 tests passing against PostgreSQL 16 with the mock provider; `npm audit` 0 vulnerabilities (2026-11-03) |
| Dependency versions | `package-lock.json` is converted from the source lockfile so every transitive version matches the tested baseline (workspace layout only) |

## Imported (KEEP/ADAPT, per the Gate 1 matrix)

`apps/resolver/src/**`, `apps/resolver/migrations/0001–0004`, the unit,
integration and adversarial tests with their synthetic provider fixtures,
`tsconfig.json`, `vitest.config.ts`, the container entrypoint and the
Dockerfile (adapted for the workspace layout).

Phase A changes on import:
* Migrations no longer run on application start by default (`RUN_MIGRATIONS_ON_START` defaults to `false`). They run as the Railway `preDeployCommand`.
* The test build resolves `tsc` through module resolution (workspace hoisting).
* Documentation references and one synthetic test address were updated for the public-safety gate.

## Not imported (STRIP/DEFER)

* All V0.1 documentation: it contains production infrastructure identifiers and live-validation records, and proposes a multi-tenant V1 that the owner has rejected.
* Deployment and live-validation scripts and their tests.
* The Lovable manifest/prompt and the mock-website integration (being rebuilt as an npm package).
* A recorded live provider response.
* The V0.1 git history.

The KEEP/ADAPT/STRIP/DEFER matrix and owner decisions are held in the
project's private tracker (Gate 1 blueprint, CHR-58/CHR-59).
