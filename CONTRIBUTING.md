# Contributing

Thanks for looking. This project is small on purpose: **no runtime dependencies, no build step,
plain Node ESM.** Please keep it that way.

## Development setup

```bash
git clone <YOUR_REPO_URL> qingping-wenfang
cd qingping-wenfang
node --version          # needs >= 20
node workshop/test.mjs  # full suite, no network, no API keys required
```

Most tests run against a loopback stub model server, so you do not need credentials to develop.
Tests that need a live endpoint are opt-in via env vars and are skipped otherwise.

## Ground rules

1. **`node:` builtins only.** A pull request that adds a runtime dependency needs a very good reason
   and will usually be asked to inline the 30 lines instead.
2. **No secrets, ever.** Keys live in `workshop/data/agents.json` or `projects/.env`; both are
   git-ignored. Do not commit example keys that look real — use `sk-test-fixture-…`.
3. **Keep the layout.** `workshop/lib/agents.mjs` resolves the repo root as `workshop/..`;
   moving `workshop/` breaks first run for everyone.
4. **One subsystem, one test file.** `workshop/test-<subsystem>.mjs`; add cases rather than new files
   when a subsystem already has one.
5. **Prompts are code.** If you change `workshop/lib/prompts.mjs`, say in the PR what output
   changed and paste a before/after sample.

## Before opening a PR

```bash
node workshop/test.mjs        # must pass
node workshop/ui-smoke.mjs    # must pass
node workshop/leak-scan.mjs   # must be clean
```

Also check that user-facing text does not leak provider or model names — the product deliberately
hides them behind agent labels and tiers. `workshop/lib/tiers.mjs` holds the word list.

## Commit messages

`area: what changed` — e.g. `judge: swap positions twice before declaring a winner`.
Keep the body about *why*; the diff already says *what*.

## Reporting bugs

Include: Node version, OS, the exact command, the full terminal error, and whether the failure
reproduces with `WORKSHOP_FORCE_AGENT` pinned to one agent.
Redact API keys, endpoints and book content before pasting.

## License of contributions

By contributing you agree your work is released under the MIT license (see `LICENSE`).
