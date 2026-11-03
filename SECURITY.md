# Security policy

This repository is **public during development** by owner decision and will be
made private before any production-grade deployment.

## Never commit

API keys, bearer tokens, HMAC secrets, database URLs, Railway or Supabase
credentials, real visitor IP addresses or fingerprints, customer or company
identification data, licensed datasets, infrastructure identifiers (project,
service, environment or deployment ids, concrete hostnames), private
agreements or `.env` files. Use synthetic fixtures only: RFC 5737
documentation addresses (`192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`)
and `example.*` domains.

## Controls

See [docs/PUBLIC_REPO_SECURITY.md](docs/PUBLIC_REPO_SECURITY.md) for the
controls in force, the evidence for each, and residual limitations.

## Reporting a vulnerability

Do not open a public issue. Contact the repository owner privately through
GitHub (Security → "Report a vulnerability" if private vulnerability reporting
is enabled, otherwise via the owner's GitHub profile).
