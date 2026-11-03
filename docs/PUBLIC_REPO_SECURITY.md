# Public repository security controls (CHR-69, owner decision D8)

The owner requires repository hygiene **before** the first source push, with
each control verified by evidence rather than assumed. This file records what
is in force, how it was verified, and what remains a limitation.

## 1. GitHub-native controls — verified state

Evidence: `GET https://api.github.com/repos/chrismarchant/id-resolver-v1.0`,
field `security_and_analysis`, read on 2026-11-03 before the first push:

| Setting | Reported status | What it covers |
|---|---|---|
| `secret_scanning` | **enabled** | Alerts for supported **provider** token formats in the repository |
| `secret_scanning_push_protection` | **enabled** | Blocks pushes containing supported provider token formats (the pusher can bypass with a justification) |
| `secret_scanning_non_provider_patterns` | disabled | Generic secrets (passwords, private keys, high-entropy strings) |
| `secret_scanning_validity_checks` | disabled | Checks whether detected tokens are live |
| `dependabot_security_updates` | disabled | Automatic security-fix PRs |

This is a point-in-time reading. The owner can change these settings at any
time under Settings → Code security; re-check before relying on them.

## 2. Residual limitations of the GitHub-native controls

1. Provider-pattern scanning **cannot recognise this project's own secrets**:
   the resolver bearer token, reporting token and IP HMAC secret are random
   strings with no provider prefix.
2. Non-provider (generic) pattern detection is reported **disabled**.
3. Push protection can be bypassed by the person pushing.
4. Neither control detects infrastructure identifiers (Railway project,
   service, environment or deployment UUIDs, concrete hostnames), real IP
   addresses or personal data, all of which matter in a public repository.
5. **On-demand scanning through the GitHub API is not available.** A
   pre-push call to GitHub's secret-scanning API on 2026-11-03 was refused
   with "Repository does not have GitHub Advanced Security enabled". This
   project therefore cannot use GitHub's engine on demand, nor custom
   patterns. The pre-push evidence comes from gitleaks and the public-safety
   gate (section 3). GitHub's scanning applies only to what is pushed.

## 3. Equivalent CI safeguards (always on, every PR and push to `main`)

| Control | Where | Verified by |
|---|---|---|
| **gitleaks 8.30.1** over the full git history, default ruleset + a narrow value-level allowlist of two synthetic test values | `.github/workflows/ci.yml` job `hygiene`; config `.gitleaks.toml` | Binary pinned by sha256 from the release checksums. A negative control (random hex and base64 tokens planted in a scratch directory) is detected with the same config. |
| **Public-safety gate**, working tree: concrete `*.up.railway.app` / `*.railway.internal` hostnames, UUID literals, public IPv4 literals outside private/reserved/RFC 5737 ranges, public IPv6 literals (global unicast outside RFC 3849 and the protocol block; times and `Foo::bar` are not addresses), non-example e-mails, private-key blocks, committed `.env`/key files. UTF-8 (BOM), UTF-16 and UTF-32 are decoded; a text file over 2 MB **fails** unless its exact path is on the reviewed list; only the root `package-lock.json` and the probe lockfile are skipped (never by basename); true binaries are not scanned and are **listed** in the output | `scripts/check-public-safety.mjs`, job `hygiene` | `scripts/check-public-safety.test.mjs` plants a violation for every rule and encoding (UTF-16 LE/BE, BOM-less, NUL, large file, nested lockfile, IPv6) and proves allowed forms pass |
| **Public-safety gate**, history: the same rules over every line **added** by any commit reachable from any ref (`git log -p --all`; added UTF-16 blobs are decoded whole; committed `.env`/key files are caught even if later deleted). Fails on a shallow clone. Reviewed historical synthetic hits are exact `commit:path:rule:value` fingerprints in `.public-safety-history-allow`, each with a justification | `node scripts/check-public-safety.mjs --history`, job `hygiene` (checkout `fetch-depth: 0`) | Self-test: a value added and later removed is found; exact-fingerprint allow-listing; UTF-16 and deleted `.env` in history; shallow clone refused |
| Dependency audit `npm audit --audit-level=high`; `npm ci --ignore-scripts` (no install hooks) | job `verify` | CI log |
| Actions pinned to full commit SHAs; `permissions: contents: read`; `persist-credentials: false` | `ci.yml` | Review |
| `.gitignore` excludes `.env*` (except `.env.example`), key files, dumps and logs | `.gitignore` | Review |
| Fresh history: V0.1 files copied selectively; V0.1 docs, deployment scripts and live fixtures **not** imported | `docs/PROVENANCE.md` | Gate (`--history`) + gitleaks over the full history |

The `public-safety: allow-synthetic` marker can opt a single line out of the
UUID, IPv4 and IPv6 rules for deliberately synthetic parser inputs. Every opt-out is
printed in the CI log for review. The marker cannot opt out of the hostname,
e-mail or key rules.

Limits, stated plainly: the gate is pattern-based (no hostname or domain allowlist beyond
the Railway patterns, no entropy checks; gitleaks covers secrets). Binary files, and
encodings other than UTF-8/16/32, are not scanned. History fingerprints name commit SHAs, so a
history rewrite makes entries stale (reported as warnings) and the reviewed hits must be
re-listed. The history allow-list file itself is excluded from scanning.

## 4. Recommended owner actions (optional, not assumed)

* Enable **non-provider patterns** and **Dependabot security updates** if your
  plan offers them for this repository.
* Before converting to private and before any production-grade deployment,
  re-run this verification and update this file.
