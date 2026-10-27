# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/) for the HTTP API (`API_VERSION`).

## [0.1.0] — 2026-10-26

First public release. The code was extracted from an internal tool used to produce serialised
web fiction; the multi-user hosting half of it is shipped as optional templates, not enabled
by default.

### Added

- **Studio UI** (`workshop/ui/index.html`): premise → proposals → bible → outline → chapter,
  with per-step progress, candidate comparison, rubric detail, version rollback and TXT export.
- **Pipeline** (`workshop/lib/pipeline.mjs`): 1–4 candidate drafts per chapter, pairwise judging
  with position swap, logic self-check, 10-axis rubric, rolling recap and foreshadowing ledger
  carried into the next chapter.
- **Per-task model routing** (`workshop/lib/agents.mjs`): 19 pipeline steps independently mapped
  to an agent; keys via `apiKey` or `keyEnv`; keys masked to four characters in the admin API.
- **Provider-neutral transport** (`workshop/lib/llm.mjs`): OpenAI-compatible and
  Anthropic-compatible chat endpoints, streaming with first-byte / idle / total watchdogs.
- **Genre rules** (`projects/genres/*.md`): editable per-genre expectations applied to the next
  chapter without restart.
- **Bookkeeping**: append-only call/usage log, per-session budget cap, estimated spend in the UI.
- **Optional multi-user deployment** (`workshop/deploy/`): systemd template service, Caddy config
  generator, invite cards, per-tier quotas, admin console. Off by default.
- **Tooling**: headless CLI (`workshop/cli.mjs`), launcher, leak scanner, headless UI smoke test
  and a test-suite with a loopback stub model server so it runs without credentials.
- **Polish pass** (`scripts/ops/humanize.mjs`, `scripts/ops/humanize-llm.mjs`): rule-based
  de-AI rewrite plus a detector-feedback rewrite, with detector adapters (`scripts/tms-aigc.mjs`,
  `scripts/orca-aigc.mjs`) and a retry/backoff wrapper.
- **Short-story lane** (`workshop/short/`): outline → draft → refine pipeline that plugs into an
  external skill bundle (`short/oh-story/`, not shipped).

### Ships without

- Style cards, hit-book corpora, rank snapshots and the short-story skill bundle are optional and
  absent from this repo; every read is guarded, so the related features simply skip and log.

### Notes

- The HTTP API is versioned (`workshop/version.mjs`, `API_VERSION = 19`); the on-disk book format
  is plain text and markdown by design.
- No corpora, no credentials, no publishing automation ship with this release.
