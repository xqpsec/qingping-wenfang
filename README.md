# Qingping Wenfang

[![ci](https://github.com/xqpsec/qingping-wenfang/actions/workflows/ci.yml/badge.svg)](https://github.com/xqpsec/qingping-wenfang/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![node >= 20](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](package.json)

**A local-first, self-hosted studio for producing long-form web novels with an LLM ensemble.**

Qingping Wenfang turns “I want to write a 300-chapter serial” into a repeatable pipeline: it drafts a
premise, builds a story bible and outline, writes several candidate drafts of every chapter,
has a separate model judge them head-to-head, scores the winner on ten axes, then lets you
revise, polish and export. Everything runs on your machine against whatever model endpoints
you point it at — no account, no cloud, no telemetry.

> 中文说明见 [README.zh-CN.md](README.zh-CN.md) · 使用手册见 [docs/使用指南.md](docs/使用指南.md)

---

## What it actually does

```text
premise ──► 3 book proposals ──► pick one
                                     │
                    story bible ◄────┘
                    chapter outline (first N chapters)
                                     │
                    ┌────────────────┴─────────────────┐
                    ▼                                  │
        write candidate draft 1..4                     │
                    │                                  │
        pairwise judge (A/B, positions swapped)        │
                    │                                  │
        logic self-check + 10-axis rubric + score      │
                    │                                  │
        revise on request ──► polish ──► export TXT ◄──┘
```

- **Multi-candidate writing.** Each chapter can be written by 1–4 different agents, then compared.
- **Pairwise judging instead of self-scoring.** Two drafts are shown to a judge model twice with
  their order swapped; only a consistent verdict wins. Ties fall back to style-similarity.
- **Rubric scoring.** Opening hook, conflict, payoff, premise novelty, protagonist, pacing,
  dialogue, genre voice, logic, chapter-end hook — 0–100, with hints, not a verdict.
- **Per-task model routing.** 19 pipeline steps (concept, bible, outline, plan, write1–4,
  judging, rubric, revise, polish, packaging…) each map to an agent you configure separately.
- **Continuity tracking.** Rolling recap + unresolved foreshadowing are carried into the next
  chapter so the model does not forget what it planted.
- **Zero dependencies.** `node:*` builtins only. No build step, no `node_modules`.
- **Local by design.** Binds `127.0.0.1` only, plain files on disk, keys never leave your box.

## Requirements

- Node.js **>= 20** (tested on Node 24)
- One or more OpenAI-compatible or Anthropic-compatible chat endpoints
  (a local llama.cpp / vLLM / Ollama endpoint works fine)

## Quick start

```bash
git clone <YOUR_REPO_URL> qingping-wenfang
cd qingping-wenfang
node workshop/server.mjs
# → open http://127.0.0.1:4580
```

On Windows you can also double-click `start.cmd`; on Linux/macOS use `./start.sh`.

First run, in the UI:

1. Open **模型配置 / Models** and add an endpoint: base URL, API key, then **Test**.
2. Assign a model to each agent (at minimum: writer, cheap, judge).
3. Create a book — or write one chapter first to see the quality before committing.

No configuration yet? The server still starts and the UI still loads; model calls will fail
until you add an endpoint.

## Configuration

### Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `WORKSHOP_PORT` | `4580` | HTTP port (always bound to `127.0.0.1`) |
| `WORKSHOP_ADMIN_TOKEN` | — | Enables the admin API/console when set |
| `WORKSHOP_ENV_FILE` | `<root>/projects/.env` | Key file loaded for `keyEnv` references |
| `WORKSHOP_SANDBOX` | — | Run against a sandbox dir (used by the test-suite) |
| `WORKSHOP_BUDGET` | — | Per-session spending cap in your currency unit |
| `WORKSHOP_STREAM_FIRST_MS` / `_IDLE_MS` / `_TOTAL_MS` | `60000` / `60000` / `480000` | Streaming watchdog thresholds |
| `WORKSHOP_FORCE_AGENT` | — | Pin every step to one agent (debugging) |

### Files it creates

```text
workshop/data/agents.json     agent config incl. API keys   (git-ignored)
workshop/data/calls.ndjson    append-only call/usage log    (git-ignored)
projects/.env                 optional key store            (git-ignored)
projects/workshop-books/<book>/
    bible.md  outline.md
    chapters/0001.txt         final text
    work/0001/                candidates, beat sheet, rubric detail
    history/                  every previous version
projects/genres/<genre>.md    genre rules (editable, takes effect next chapter)
```

`workshop/lib/agents.mjs` resolves the repository root as `workshop/..`, so **keep the
`workshop/` directory level** when you move things around.

### Optional data you can drop in

Nothing below is required — every read is guarded, and missing files simply disable the
feature. They are not shipped with this repo (third-party content and personal corpora):

```text
projects/genres/cards/<style>.md    extra style cards → they appear in the style picker
data/knowledge/rank/                hit-book library used by the packaging agent
data/knowledge/chapters/            corpus for the offline benchmark scripts
data/intel/                         rank snapshots for the short-story pipeline
short/oh-story/                     the oh-story skill bundle used by the short-story module
```

The short-story module (`workshop/short/`) is a separate lane that talks to an
external skill bundle: it loads `<repo>/short/oh-story/story-short-write/references/*.md`
and runs the bundle's own checker scripts. Tests and prompts that need those files
report "skill bundle not installed" and skip instead of failing. Its anchor samples
(`WORKSHOP_SHORT_ANCHORS`) are optional too — without them, scoring runs unanchored.

## Repository layout

```text
workshop/
  server.mjs          HTTP server + JSON API (API_VERSION 19)
  cli.mjs             headless CLI (same pipeline, no browser)
  launcher.mjs        one-click launcher
  lib/                pipeline, agents, judging, store, prompts, packaging…
  ui/                 index.html (studio) · admin.html · customer-lab.html
  deploy/             optional multi-user Linux deployment (systemd/Caddy templates)
  test*.mjs           test-suite, one file per subsystem
  short/              short-story lane (needs the oh-story bundle, see above)
scripts/
  ops/humanize.mjs        rule-based de-AI polish pass (zero model calls)
  ops/humanize-llm.mjs    model-driven rewrite pass with detector feedback
  tms-aigc.mjs            detector adapter (text-moderation style AIGC probe)
  tms-robust.mjs          retry/backoff wrapper for the detector
  orca-aigc.mjs           second detector adapter (optional)
projects/             your books (ignored)
docs/                 usage guide
```

## CLI

```bash
node workshop/cli.mjs --help        # pipeline operations without the UI
node workshop/test.mjs              # full test-suite
node workshop/ui-smoke.mjs          # headless UI smoke test
node workshop/leak-scan.mjs         # scan generated output for model/provider leakage
```

## Multi-user deployment (optional)

`workshop/deploy/` contains a template for running one instance per user behind systemd +
Caddy, with per-user budgets and invite cards. It is **off by default** and assumes you know
your own host: read `workshop/deploy/README.md` before using it. The application itself has
no authentication — it trusts the loopback interface. Do not expose the port directly to the
internet.

## Not included

- **No corpora.** Style-similarity baselines are built from your own corpus with
  `workshop/build-baseline.mjs`; no third-party text ships with this repo.
- **No credentials.** Bring your own endpoints and keys.
- **No publishing automation.** Export is a file; uploading to a platform is your call.

## License

MIT — see [LICENSE](LICENSE).
