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
| **Public-safety gate**, working tree: concrete `*.up.railway.app` / `*.railway.internal` hostnames, UUID literals, public IPv4 literals outside private/reserved/RFC 5737 ranges, public IPv6 literals (global unicast outside RFC 3849 and the protocol block; times and `Foo::bar` are not addresses), non-example e-mails (RFC 2606/6761 names and their subdomains, and git noreply addresses such as `noreply@anthropic.com` and `*@users.noreply.github.com`, are allowed), private-key blocks, committed `.env`/key files. UTF-8 (BOM), UTF-16 and UTF-32 are decoded; a text file over 2 MB **fails** unless its exact path is on the reviewed list; only the root `package-lock.json` and the probe lockfile are skipped (never by basename); true binaries are not scanned and are **listed** in the output | `scripts/check-public-safety.mjs`, job `hygiene` | `scripts/check-public-safety.test.mjs` plants a violation for every rule and encoding (UTF-16 LE/BE, BOM-less, NUL, large file, nested lockfile, IPv6) and proves allowed forms pass; it also proves the default output (tree and history) holds no planted value and no part of its SHA-256, that the local-only `--show-values` and `--fingerprints` work and are refused in CI, and that `ci.yml` passes neither |
| **Public-safety gate**, history: the same rules over every line **added** by any commit reachable from any ref (`git log -p --cc --all`: for a merge, what the merge resolution itself introduced; added UTF-16 blobs are decoded whole; committed `.env`/key files are caught even if later deleted, also when empty or binary or under a path git C-quotes (a `"`, `\`, tab or control character: history paths are read NUL-separated, and quoted diff headers are un-quoted); a line is a file header only between `diff --git` and the first `@@`, so added content starting with `++ ` is scanned), every **commit message** and **annotated tag message**, and **author, committer and tagger identities** with every rule except `email` (see below). Fails on a shallow clone. Reviewed historical synthetic hits are exact `commit:path:rule:sha256(value)` fingerprints in `.public-safety-history-allow` (see "History allow-list" below) | `node scripts/check-public-safety.mjs --history`, job `hygiene` (checkout `fetch-depth: 0`) | Self-test: a value added and later removed is found; a value only in a merge resolution; an added `++ ` line; public IPv4/host/UUID in a commit message, a tag message and an identity; noreply co-author trailers stay quiet; exact hashed-fingerprint allow-listing (one entry waives one hit); refused rules, missing justifications and raw values in the allow-list fail; UTF-16, empty or binary forbidden files, forbidden files under C-quoted paths and deleted `.env` in history; shallow clone refused |
| Dependency audit `npm audit --audit-level=high`; `npm ci --ignore-scripts` (no install hooks) | job `verify` | CI log |
| Actions pinned to full commit SHAs; `permissions: contents: read`; `persist-credentials: false` | `ci.yml` | Review |
| `.gitignore` excludes `.env*` (except `.env.example`), key files, dumps and logs | `.gitignore` | Review |
| Fresh history: V0.1 files copied selectively; V0.1 docs, deployment scripts and live fixtures **not** imported | `docs/PROVENANCE.md` | Gate (`--history`) + gitleaks over the full history |

The `public-safety: allow-synthetic` marker can opt a single line out of the
UUID, IPv4 and IPv6 rules for deliberately synthetic parser inputs. Every opt-out is
printed in the CI log for review. The marker cannot opt out of the hostname,
e-mail or key rules.

### History allow-list (`.public-safety-history-allow`)

* An entry is `<full commit sha>:<path>:<rule>:<sha256 hex of the value>` and waives exactly
  one value in one file of one commit. The file holds hashes, never the flagged values.
* The file is scanned like any other file, in both modes, so a raw value written into it,
  even in a comment, is a finding.
* Every entry needs a non-empty `# ...` justification directly above it, or above its block
  of consecutive entries. A blank line in between does not count.
* Entries for `forbidden-file`, `private-key-block`, `email`, `railway-public-host` and
  `railway-private-host` are refused as a hard error, as are malformed entries (including
  the old raw-value format) and unknown rules. These hits need history rewriting and
  credential rotation, not a waiver; for them the gate prints that remediation and never
  a fingerprint.
* Every other history finding carries the remediation: a real value must be removed from
  history and rotated or revoked; only a **synthetic** value may be listed.
* To obtain an entry, run `node scripts/check-public-safety.mjs --history --fingerprints`
  **locally**. It prints the fingerprint under each waivable finding. CI never prints
  fingerprints (see "Output" below); a failing history run says so and names this command.
* The file is validated in every mode (tree, `--staged`, `--history`).

Limits, stated plainly: the gate is pattern-based (no hostname or domain allowlist beyond
the Railway patterns, no entropy checks; gitleaks covers secrets). Binary files, and
encodings other than UTF-8/16/32, are not scanned. History fingerprints name commit SHAs, so a
history rewrite makes entries stale (reported as warnings) and the reviewed hits must be
re-listed.

### Output: no matched value, and no hash of one, by default

The repository and its Actions logs are public, so a real leak the gate catches must not be
republished in the CI log (gitleaks runs with `--redact` for the same reason). A hash is no
protection here: an IPv4 address can be recovered from its SHA-256 by trying all 2^32
addresses, and an e-mail address or hostname by guessing, so a hash of a low-entropy value is
effectively the value.

* By default (CI and local) a finding or a marked opt-out shows only its location (path or
  pseudo-path, line or commit), the rule and `[redacted: <length> chars]`: no value, no hash,
  no hash prefix and no fingerprint. Findings keep their remediation text.
* git runs with its stderr captured, and an internal error prints only the gate's own
  messages (otherwise the error type and exit status), so no git diagnostic is echoed.
  Large-file and binary listings name paths and sizes only. Unused allow-list entries are
  named by line, commit, path and rule.
* Two flags are for **local use only**. The gate refuses each with exit 2 when `CI` or
  `GITHUB_ACTIONS` is set, and `.github/workflows/ci.yml` passes neither (the self-test
  checks this):
  * `--fingerprints` (with `--history`) prints the allow-list entry under each waivable
    finding. Use it for synthetic values only.
  * `--show-values` prints the raw matched values, and full internal error messages.
* The allow-list file itself is public and holds hashes; by policy those are hashes of
  synthetic values only.

Author and committer (and tagger) **e-mail addresses are not checked** by the `email` rule:
every commit carries them, so the rule would only ever demand history rewrites for git's
own metadata. Identities are still scanned with every other rule (an IP address, UUID or
Railway host in a name or e-mail is a finding). The repository's root commit carries the
owner's own author e-mail; publishing it is the owner's choice, and the gate does not
report it. Contributors who want privacy should commit with a noreply address. History
mode scans every ref the local clone has (`--all`, including other local branches and a
local stash), so a local run can report hits that CI, which sees only pushed refs, does not.

## 4. Recommended owner actions (optional, not assumed)

* Enable **non-provider patterns** and **Dependabot security updates** if your
  plan offers them for this repository.
* Before converting to private and before any production-grade deployment,
  re-run this verification and update this file.
