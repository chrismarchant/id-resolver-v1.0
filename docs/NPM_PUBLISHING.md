# npm publication of the collector and the TanStack adapter (owner decision D5)

Status: **requirements and a draft workflow only.** Nothing has been published, no npm organisation, account,
token or trusted publisher was created or used, and no registry credential exists in this session or this
repository. `npm pack --dry-run` was run locally without authentication (section 5). Every step marked **owner**
needs the owner's separate approval.

D5: the server adapter `@id-resolver/tanstack` and the collector `@id-resolver/collector` are published
to public npm under an owner-controlled scope.

## 1. Sources

`docs.npmjs.com` and `docs.github.com` could not be opened from the session that wrote this (network policy). The
facts below come from web search results that quote those pages and are marked **SEARCH-ONLY**; confirm each on the
live page before acting. **UNVERIFIED** means no source was found. Registry facts marked **REGISTRY** were read
directly and unauthenticated with `npm view` on 3 Nov 2026.

| fact | source | read | status |
|---|---|---|---|
| npm trusted publishing (OIDC from GitHub Actions; also GitLab) is generally available since 31 Jul 2025 | https://github.blog/changelog/2025-07-31-npm-trusted-publishing-with-oidc-is-generally-available/ | 3 Nov 2026 | SEARCH-ONLY |
| it requires npm CLI **11.5.1 or later**; the CLI detects the OIDC environment itself and uses it before any token | https://docs.npmjs.com/trusted-publishers | 3 Nov 2026 | SEARCH-ONLY |
| the workflow needs `permissions: id-token: write`; the trusted publisher is configured per package (organisation or user, repository, workflow file name, optional environment) | https://docs.npmjs.com/trusted-publishers | 3 Nov 2026 | SEARCH-ONLY |
| with trusted publishing, provenance attestations are generated automatically (no `--provenance` needed); not for private source repositories | GitHub changelog above; https://docs.npmjs.com/trusted-publishers | 3 Nov 2026 | SEARCH-ONLY (the exact conditions were not found) |
| `actions/setup-node` with `registry-url` writes an `.npmrc` expecting `NODE_AUTH_TOKEN`, which can get in the way of OIDC | third-party write-up | 3 Nov 2026 | UNVERIFIED (the draft workflow avoids `registry-url` anyway) |
| npm's 2025 hardening: classic tokens deprecated and revoked; publishing access to "disallow tokens" pushed towards trusted publishing or 2FA-enforced local publishing; granular write tokens limited in lifetime (7 or 90 days, sources differ); TOTP 2FA to be replaced by FIDO/WebAuthn | https://www.helpnetsecurity.com/2025/09/23/npm-publishing-security-improvements/ (secondary), https://github.com/npm/documentation/pull/2006 | 3 Nov 2026 | SEARCH-ONLY |
| whether a trusted publisher can be configured **before** a package's first version exists | none found | — | UNVERIFIED (see 2.4) |
| npm 11.21.1 (published 15 Oct 2026) supports Node `^20.17.0 \|\| >=22.9.0`; npm `latest` is 12.2.1; Node 22.23.4 bundles npm 10.9.9 | `npm view npm` | 3 Nov 2026 | REGISTRY / local |
| `@id-resolver/collector` and `@id-resolver/tanstack` do not exist on the registry (404) | `npm view` | 3 Nov 2026 | REGISTRY. Whether the `@id-resolver` **scope** is already owned, and by whom, needs an authenticated check by the owner |

## 2. Prerequisites (owner actions)

### 2.1 npm account and organisation

1. The owner's npm account, with two-factor authentication using a **security key or passkey** (WebAuthn), not
   TOTP (npm is moving away from TOTP, SEARCH-ONLY).
2. The npm organisation **`id-resolver`** (scope `@id-resolver`), owned by the owner. If the scope is already
   taken by someone else, D5 needs a new scope name before anything else.
3. Organisation settings: require 2FA for every member; members limited to the owner (and, if wanted, one backup
   owner account held by the owner). No automation user and no long-lived token.

### 2.2 GitHub side

1. A GitHub **environment** `npm-release` in this repository: required reviewer = the owner; deployment rule =
   tags `idr-collector-v*` and `idr-tanstack-v*` only; no environment secrets (none are needed).
2. A **tag ruleset** so that only the owner can create or move tags matching `idr-*-v*`.
3. Actions settings: only actions pinned by full SHA (the repository already pins `actions/checkout` and
   `actions/setup-node`; the draft uses only these two).

### 2.3 Trusted publishing, per package

On npmjs.com, in each package's settings, add a trusted publisher: GitHub Actions, the repository
`<GITHUB_OWNER>/<REPO>`, workflow file `release-npm.yml`, environment `npm-release`. Then set the package's
publishing access to **require 2FA and disallow tokens** (wording SEARCH-ONLY), so that only the trusted publisher
(or the owner with 2FA, by hand) can publish.

### 2.4 The first version

If npm only offers the trusted-publisher form for an existing package (UNVERIFIED), the first version needs a
bootstrap. Options, for the owner to choose:

* **(a) Recommended:** the owner publishes the first version by hand, with 2FA, from a clean checkout of the tagged
  commit, using exactly the tarball the checks in section 4 approved (`npm publish <tarball> --access public
  --tag next`). That version has **no provenance**. Then configure the trusted publisher and release the next
  version (for example `0.1.1` or `0.1.0-rc.2`) through the workflow; mark the hand-published version as superseded
  in the changelog.
* **(b)** A short-lived granular token with publish rights for the first run only, stored as an environment
  secret of `npm-release`, revoked right after. Gives provenance from the start, but creates a token, which this
  plan otherwise avoids.

## 3. Package readiness checklist

Findings from the current manifests (version `0.1.0-dev.0`) and `npm pack --dry-run` (section 5). Items marked
**blocking** must be resolved before the first publish; the draft workflow's gate refuses to publish while the
first three are open.

| item | collector | tanstack | action |
|---|---|---|---|
| `private: true` | present | present | **blocking**: remove in the release commit |
| `license` | `UNLICENSED`, no LICENSE file | same | **blocking, owner decision**: on public npm `UNLICENSED` grants nobody the right to use the package. Choose a licence, add `LICENSE` to each package directory (it is then packed automatically) and set the SPDX id |
| `repository` | missing | missing | **blocking** for provenance (npm checks it against the publishing repository; UNVERIFIED in this session): `{ "type": "git", "url": "git+https://github.com/<GITHUB_OWNER>/<REPO>.git", "directory": "packages/<dir>" }` |
| `publishConfig` | missing | missing | add `{ "access": "public", "provenance": true }` (a scoped package is otherwise restricted) |
| version | `0.1.0-dev.0` | same | first public version `0.1.0-rc.1` on dist-tag `next`, then `0.1.0` on `latest` after the staging results (docs/staging). SemVer: the wire contracts (`entrance.v1`, `event.v1`) and the embedded vocabulary (`event-vocabulary.v1`) are versioned separately; a new contract or vocabulary version is a minor bump at least, removing an option a major |
| `exports` / `main` / `types` | `.`, `./idr-collector.min.js`, `./package.json`; ESM | `.`, `./package.json`; ESM | fine as they are |
| `files` | `dist`, `README.md` | `dist`, `README.md`, `LOVABLE_SETUP.md` | fine; LICENSE is added automatically once it exists |
| `sideEffects: false` | yes | yes | fine |
| `engines` | none (browser) | `node >=22 <23` | change tanstack to `>=22`: `<23` makes installs warn (or fail with `engine-strict`) on Node 24 for no reason; Cloudflare Workers ignore it |
| source maps | none (`sourceMap: false`) | none | fine; keep it so |
| README | says "not published"; says the vocabulary is "proposed and pending owner approval (CHR-59)", which is stale (approved 3 Nov 2026) | says "not published"; links to `verification/RESULTS.md` and `docs/contracts/...`, which are not in the tarball | update both at release; turn repository-relative links into absolute links pinned to the release tag |
| metadata | — | — | optional: `homepage`, `bugs`, `keywords` |

Gates that must pass on the release commit (the draft workflow enforces them):

* `npm run verify` for the package, with `IDR_REQUIRE_PROBE=1` (the bundle-safety test builds the probe app and
  scans its client assets; without the probe it is skipped, which must not count) and `IDR_REQUIRE_BROWSER=1`
  (the collector's real-Chrome CSP test).
* Size budgets: the collector's minified bundle **<= 3072 bytes gzip** (enforced by its test; 2253 now); packed
  tarballs **<= 20,000 bytes** (collector, 11,905 now) and **<= 60,000 bytes** (tanstack, 38,496 now).
* `npm audit --audit-level=high` clean; the public-safety gate and gitleaks clean (`ci.yml` on the same commit).
* **Content review** of the tarball: exactly the allowlisted files below; no tests, no source maps, no `.env`, no
  `tsbuildinfo`, no fixtures.
* SBOM: optional. Both packages have **zero runtime dependencies**, so an SBOM would list only the package itself;
  `npm sbom --sbom-format cyclonedx -w <package>` can be attached to the GitHub release if wanted.

## 4. Release workflow (draft)

The draft is [`docs/staging/release-npm.workflow.draft.yml`](staging/release-npm.workflow.draft.yml). It is
deliberately **not** in `.github/workflows/`, so it cannot run. Summary:

1. **Trigger:** a tag `idr-collector-v<semver>` or `idr-tanstack-v<semver>`, or a manual run on such a tag ref.
   Never a branch.
2. **gate** (`contents: read`, `actions: read`): maps the tag to the package; refuses when the tag and
   `package.json` versions differ, the package is still `private`, the licence is `UNLICENSED` or missing, or
   `repository.url` is missing; requires the tagged commit to be on `main` and a **successful `ci.yml` run for that
   exact commit**. Prereleases always go to dist-tag `next`.
3. **verify** (`contents: read`): `npm ci`, `npm audit`, the probe install, and the package's `verify` with the
   probe and browser tests required.
4. **publish** (`contents: read`, `id-token: write`): waits for the **owner's approval** of the `npm-release`
   environment; installs npm **11.21.1** exactly (trusted publishing needs 11.5.1 or later; Node 22 ships 10.x);
   builds; checks the exact tarball contents against an allowlist, the version and the size budget; then
   `npm publish -w <package> --access public --tag <dist-tag> --provenance --ignore-scripts`. There is **no npm
   token**: authentication is the OIDC trusted publisher.
5. **Pinning and injection:** both actions are pinned to the full commit SHAs already used in `ci.yml`
   (`actions/checkout` v7.0.1, `actions/setup-node` v7.1.0). Tag names and inputs reach shell steps only through
   environment variables. `setup-node` gets no `registry-url`.

Local dry runs of the draft's shell steps (3 Nov 2026): the gate step refuses today's manifests ("still has private:
true"), a version mismatch, a non-semver or injected tag, and an unknown tag prefix; the pack-check step passes both
current tarballs (7 and 33 files) and fails a version mismatch.

After a release: check the package page shows the provenance statement linked to the workflow run, and that the registry
metadata of the version lists an attestation (`npm view <package>@<version> dist`; field name UNVERIFIED); install the tarball into the staging site and re-run the
`bundle` phase of `docs/staging/acceptance/cf-site-check.mjs`.

## 5. `npm pack --dry-run` (local, unauthenticated, 3 Nov 2026)

Run after `npm run build -w <package>` (version `0.1.0-dev.0`, commit `a316310`, Node 22.23.4, npm 10.9.9). No
`.npmrc` and no auth token were present.

`@id-resolver/collector`: 7 files, 11,905 bytes packed, 34,981 unpacked.

| bytes | path |
|---|---|
| 12424 | README.md |
| 4625 | dist/idr-collector.min.js (2253 gzip) |
| 2706 | dist/index.d.ts |
| 12421 | dist/index.js |
| 948 | dist/vocabulary.d.ts |
| 723 | dist/vocabulary.js |
| 1134 | package.json |

`@id-resolver/tanstack`: 33 files, 38,496 bytes packed, 118,986 unpacked: `LOVABLE_SETUP.md` (2244),
`README.md` (24354), `package.json` (998), and `dist/<module>.js` + `dist/<module>.d.ts` for each of `build`,
`collector-route`, `config`, `connectivity`, `delivery`, `eligibility`, `index`, `ip`, `middleware`, `payload`,
`runtime`, `schedule`, `trust`, `types`, `vocabulary` (largest: `collector-route.js` 13805, `payload.js` 13586).

What should not ship, or is missing:

* **Nothing unwanted ships**: no test, fixture, source map, `.env`, `tsbuildinfo` or probe file.
* **Missing:** a `LICENSE` file (and a real licence), a `repository` field, `publishConfig`.
* **Content to fix:** the stale vocabulary status and "not published" wording in the READMEs; repository-relative
  links in the tanstack README that do not resolve on npmjs.com; the tanstack `engines` upper bound.

## 6. Owner actions, in order

1. Decide the licence (blocking) and confirm the scope `@id-resolver` is the owner's.
2. Create or confirm the npm organisation; 2FA with a security key; org 2FA requirement.
3. GitHub: environment `npm-release`, tag ruleset.
4. Approve a release-preparation change (by a cell): `private` removed, licence, `repository`, `publishConfig`,
   `engines`, README updates, version `0.1.0-rc.1`; and the activation of the workflow (copy to
   `.github/workflows/release-npm.yml`).
5. First version per 2.4; trusted publisher per package (2.3); "disallow tokens".
6. Tag, approve the environment, check provenance on the package page.
