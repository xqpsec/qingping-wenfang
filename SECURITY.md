# Security

## Threat model

Qingping Wenfang is a **single-user, local-first** application. It deliberately has no login:

- the HTTP server binds `127.0.0.1` only;
- there is no authentication on the main API;
- every request is assumed to come from you, on your machine.

Therefore: **do not expose the port to a network you do not control.** If you need remote access,
put it behind a VPN or an authenticating reverse proxy, and set `WORKSHOP_ADMIN_TOKEN`.
The optional `workshop/deploy/` template does this per-user (one process per user, Caddy in front),
but it is a starting point, not a hardened multi-tenant service.

## Where secrets live

| What | Path | Git-ignored |
|---|---|---|
| Agent config incl. API keys | `workshop/data/agents.json` | yes |
| Optional key store | `projects/.env` | yes |
| Call/usage log (contains prompts) | `workshop/data/calls.ndjson` | yes |

Keys are never written into the UI bundle and are masked to the last four characters when the
admin API returns configuration.

Prompt and response bodies are logged to `calls.ndjson` for cost accounting. If your book content
is sensitive, delete that file or keep `workshop/data/` out of any backup you share.

## Things this project does not protect you from

- A model endpoint you added that logs your prompts (that is between you and your provider).
- Other processes on the same machine reading your files.
- Publishing generated text that reproduces someone else's copyrighted work.

## Reporting a vulnerability

Please do not open a public issue for a security problem. Use GitHub private vulnerability
reporting on the repository, or email **security@example.com** with:

- affected version / commit,
- reproduction steps,
- impact you believe it has.

You will get an acknowledgement within a few days. Please give a reasonable window before
disclosing publicly.
