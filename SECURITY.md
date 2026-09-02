# Security policy

## Secrets

Never commit API keys, provider credentials, `.env` files, or the local `.data/` directory.

Provider credentials are encrypted locally with AES-256-GCM. The ciphertext and its randomly generated master key are stored in `.data/` with restrictive filesystem permissions. Both are machine-local runtime data and are excluded from Git.

If a secret is ever committed, deleting it in a later commit is not enough. Revoke or rotate it immediately, then remove it from the complete Git history before publishing the repository.

## Deployment boundary

The included Node server is designed for local, single-user use and listens on `127.0.0.1` by default. Do not expose it directly to the public internet.

A hosted version must add, at minimum:

- HTTPS and secure proxy configuration;
- account authentication and authorization;
- per-user encrypted credential storage backed by a managed key service;
- CSRF protection, request rate limits, and stricter request validation;
- security logging without recording credentials or transcript contents.

## Reporting

Do not open a public issue containing credentials, private transcripts, or recorded audio. Share only a minimal reproduction with all sensitive information removed.
