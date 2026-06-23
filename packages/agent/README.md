# @kgpacks/agent

The strict-ESM **LLM layer** of the port: a thin wrapper around the **GitHub
Copilot SDK** ([`@github/copilot-sdk`](https://www.npmjs.com/package/@github/copilot-sdk))
that exposes the four agent operations carried over from the Python system —
**answer synthesis**, **query expansion**, **multi-query generation**, and
**seed-article identification** — plus **token/usage accounting** equivalent to
the Python `_track_response`.

The SDK changes _transport only_. Per [docs/PLAN.md](../../docs/PLAN.md) the same
synthesis model is used via **BYOK** and held constant, so model behavior — and
therefore eval quality — is unchanged; only the plumbing moves from the Anthropic
SDK to the Copilot SDK.

`@github/copilot-sdk` is pinned to the exact version **`1.0.3`** (no range) and
the lockfile is committed for reproducible installs. The SDK transport is wrapped
behind an injectable `Transport` seam, so unit tests run **fully offline** against
a mock and never spawn the Copilot CLI subprocess or require credentials.

```ts
import { CopilotAgent } from '@kgpacks/agent';

const agent = new CopilotAgent(); // BYOK the pinned synthesis model
await agent.start();
try {
  const { answer, usage } = await agent.synthesizeAnswer({
    question: 'How does HNSW indexing work?',
    context: [{ id: 'doc:1', text: 'HNSW builds a navigable small-world graph…' }],
  });
  console.log(answer, usage.totalTokens);
} finally {
  await agent.stop();
}
```

See [docs/packages/agent.md](../../docs/packages/agent.md) for the full API
reference, request/response schemas, the transport seam, error model, and the
usage-accounting and testing strategy, and [docs/PLAN.md](../../docs/PLAN.md) for
the port plan and parity methodology.
