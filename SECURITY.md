# Security policy

## Supported versions

ledgerline is a small self-hosted project. Security fixes are made on `main`; please run the latest
version.

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub Security Advisories:
[github.com/sandrich/ledgerline/security/advisories/new](https://github.com/sandrich/ledgerline/security/advisories/new)

Include what you found, how to reproduce it and the impact you expect. You will get an answer as soon
as possible, usually within a week. Once a fix is available the advisory is published and you are
credited unless you prefer otherwise.

## Scope and threat model

ledgerline is read-only towards the blockchain: it never holds private keys and never signs or sends
transactions. It has **no authentication** and is designed to listen on `127.0.0.1` and be reached
through a private network such as Tailscale or an SSH tunnel.

In scope, for example:

- Leaking wallet data, RPC keys or the contents of `.env` (in logs, API responses, error messages or
  the built client bundle)
- Stealth mode showing amounts it should mask
- Request handling that lets a page or another site change data (CSRF, injection, path traversal)
- Unsafe defaults in the Docker or example systemd setup

Out of scope:

- Exposing the app to the public internet (for example with Tailscale Funnel or `HOST=0.0.0.0` behind
  a public IP). This is unsupported by design.
- Incorrect balances or prices from upstream data sources. Please open a normal bug report.
