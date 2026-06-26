# Knowledge-pack catalog

The `catalog/` directory is the consolidated, data-driven source for every
knowledge pack shipped by this project. It replaces the reference repo's 68
hand-written `build_*_pack.py` scripts with **data + one builder**: each pack is a
folder of declarative inputs, and a single script (`scripts/build-catalog.mjs`)
turns any subset of them into LadybugDB packs.

## Layout

```
catalog/
  <pack-name>/
    urls.txt        # newline-delimited seed URLs (the only per-domain config)
    manifest.json   # pack metadata: name, version, description, graph_stats
    eval.jsonl      # one JSON object per line: { id, domain, difficulty,
                    #                              question, ground_truth }
```

There are **48 packs** (2,647 seed URLs, 2,648 eval questions). Adding a pack is
adding a folder with these three files — no code.

## What is and isn't committed

- **Committed:** the `catalog/` inputs above (text, small).
- **Not committed:** the built `data/packs/<pack>/pack.db` binaries. They are
  generated artifacts (gitignored via `data/packs/**/*.db`) — rebuild them with
  the builder rather than checking them in.

## Building packs

The builder fetches each seed, extracts entities/relationships with the GitHub
Copilot SDK, embeds with BGE (Transformers.js/ONNX), and writes the graph + vector

- FTS indexes to `data/packs/<pack>/pack.db`.

```bash
pnpm -r build                                   # compile packages first

pnpm catalog:list                               # list available packs
pnpm catalog:build --pack go-expert             # build one pack
pnpm catalog:build --pack go-expert,rust-expert # build several (comma-separated)
pnpm catalog:build                              # build the entire catalog
```

Flags (forwarded to `scripts/build-catalog.mjs`):

| Flag             | Default | Meaning                                   |
| ---------------- | ------- | ----------------------------------------- |
| `--pack <a,b>`   | all     | Restrict to the named pack(s).            |
| `--max-articles` | `60`    | Cap articles ingested per pack.           |
| `--max-depth`    | `1`     | Crawl depth from the seeds (must be ≥ 1). |
| `--list`         | —       | Print pack names and exit.                |

Each pack prints a one-line JSON summary (article/section/chunk/entity/
relationship counts + seconds); the run exits non-zero if any pack failed.

> **This is a long batch.** Live LLM extraction runs at roughly 4–5 minutes per
> article, so the full catalog is a multi-hour job — run it on a server, not
> inline. Use `--max-articles` to produce smaller packs quickly during
> development. This is runnable batch tooling, not deferred work.

## Evaluating packs

`scripts/eval-catalog.mjs` runs the same two-arm parity comparison the reference
repo reports, over a pack you have already built:

- **with-pack** — full retrieve-then-synthesize over the pack;
- **training-only** — the model answering from its own knowledge, no retrieval;

both graded by the **held-constant LLM judge** (`claude-opus-4.5`) against each
question's `ground_truth`.

```bash
pnpm catalog:build --pack go-expert --max-articles 4   # build first
pnpm catalog:eval --pack go-expert --sample 3          # then evaluate
```

It prints per-arm accuracy / mean score and a head-to-head comparison
(wins / losses / ties), demonstrating the pack's lift over the bare model.

## Models

- **Synthesis / extraction:** `claude-opus-4.8` (`@kgpacks/agent`
  `DEFAULT_SYNTHESIS_MODEL`).
- **Judge:** `claude-opus-4.5` (`@kgpacks/eval` `DEFAULT_JUDGE_MODEL`) — held
  constant across both eval arms; changing it is a re-baseline event. Override per
  run with `--judge-model`.

Both are served by the authenticated GitHub Copilot CLI; sign in with `copilot`
before building or evaluating.
