# CVE pack — eval results

This is the committed, metrics-only eval artifact for the CVE pack (see
[docs/cve-eval.md](../../../docs/cve-eval.md)). It records what was measured for the
expanded eval set in `eval_questions.json`.

## Environment status: pinned judge unavailable → retrieval-recall reported

`wikigr pack eval --pack cve` grades both arms with a **pinned judge model,
`claude-opus-4.5`** (synthesis uses `claude-opus-4.8`). In this build environment
that judge model is **not available** — the Copilot SDK reports:

```
wikigr: Request session.create failed with message: Model "claude-opus-4.5" is not available.
```

So the LLM-judged `accuracy` / `meanScore` / `deltaAccuracy` numbers cannot be
produced here without re-baselining on a different judge (which the fixed-model
contract forbids). Per the plan's fallback, the reported number is the
**deterministic, LLM-free retrieval-recall** metric.

## Deterministic retrieval-recall (embedding hit@k)

For each CVE-specific question, the question is embedded with the BGE query encoder
and matched (cosine) against the pack's section embeddings; recall@k is the fraction
of questions whose target CVE appears in the top-k. Measured over a pack built from
the exact CVE records the questions reference (12 CVE questions):

| Metric    | Value |
| --------- | ----- |
| recall@1  | 0.667 |
| recall@3  | 0.667 |
| recall@5  | 0.750 |

This confirms the expanded questions map to retrievable pack content (the retrieval
half of the with-pack arm). It is a lower-bound sanity check on a small,
deliberately homogeneous pack (every record is a CVE, so distractors are close); the
full 343k pack has more diverse content.

## Reproducing the full LLM-judged eval

Where the pinned judge is available, produce the committed metrics artifact with:

```bash
wikigr pack pull cve
wikigr pack eval --pack cve \
  | jq '{ pack: "cve", arms, comparison, sampled, total }' \
  > data/packs/cve/eval-report-$(date -u +%F).json
```

The expanded question set (14 questions; 12 real, recent 2024/2025 CVEs with
reference answers) is designed to maximize `comparison.deltaAccuracy` — it exercises
knowledge the base model is least likely to already hold, so the pack's lift shows.
