# agent-kgpacks (TypeScript)

TypeScript port of [agent-kgpacks](https://github.com/rysweet/agent-kgpacks) — a
knowledge-pack platform that builds domain knowledge graphs from documentation,
stores them in **LadybugDB** (graph + vector + FTS), and answers questions with a
graph-RAG agent powered by the **GitHub Copilot SDK**.

> Status: **early scaffolding**. See [docs/PLAN.md](docs/PLAN.md) for the full
> end-to-end port plan (phases, parity methodology, acceptance criteria).

## Why a TypeScript port?

- Single-language stack (the existing frontend is already TypeScript/React).
- Agent interactions via the GitHub Copilot SDK.
- No Python dependency in the shipped artifact (Python is used only as a
  development-time parity oracle).

## License

MIT
