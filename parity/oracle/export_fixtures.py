#!/usr/bin/env python3
"""Dev-time golden-fixture exporter for the agent-kgpacks TypeScript parity harness.

This script is the *oracle* side of the parity harness (see docs/PLAN.md ->
"Parity Methodology"). It emits a committed JSON fixture that freezes the
expected output of each pipeline stage so the TypeScript port can be diffed
against it stage-by-stage:

    query  ->  query-embedding  ->  retrieved-ids  ->  reranked-ids  ->  final-answer

Two modes
---------
* STUB mode (the default, what ships here): runs on the Python *standard library
  alone* -- no `pip install` required. It produces small, deterministic,
  synthetic stage outputs so the fixture *contract* (schema + provenance) is
  fully defined and regenerable on any machine with Python 3.9+.
* REAL mode (not wired up here): the same provenance/serialization scaffold, but
  the synthetic `_stage_*` helpers below would be replaced by calls into the
  upstream Python `agent-kgpacks` modules (sentence-transformers embedder,
  retriever, cross-encoder reranker, synthesizer). Pin that environment with
  `requirements.txt` in this directory.

Dev-only boundary
-----------------
This file is intentionally OUTSIDE every runtime package's dependency graph
(`packages/*`). Python must never be importable or invokable by shipped code;
`scripts/check-no-python.mjs` enforces that for `packages/*`, and CI must assert
runtime packages stay Python-free. See parity/README.md.

Usage
-----
    python3 parity/oracle/export_fixtures.py                # overwrite the sample fixture in place
    python3 parity/oracle/export_fixtures.py --out other.json --seed 7

The repository's Prettier gate formats committed JSON, so after regenerating run
Prettier on the output (the README documents the one-line regen command).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

SCHEMA_VERSION = 1

# Model identifiers the REAL oracle would use; recorded as provenance so a stale
# fixture is obvious. Mirrored by requirements.txt for real-mode reproduction.
MODELS = {
    "queryEmbedding": "BAAI/bge-base-en-v1.5",
    "reranker": "cross-encoder/ms-marco-MiniLM-L-6-v2",
    "answer": "stub-deterministic",
}
BINDING_VERSION = "@ladybugdb/core@0.17.1"
STORAGE_VERSION = "kgpack-storage@1"

# Fixed placeholder answer text. This is a STUB: the synthesized answer of the
# real oracle is provider-dependent, and the parity harness ignores answer text
# anyway (it compares citations/topK/seed). Keeping it constant makes the stub's
# stage output reproducible.
STUB_ANSWER_TEXT = (
    "A knowledge pack is a portable, queryable graph of documents and their relationships."
)

# Default output: overwrite the committed sample fixture consumed by the vitest
# suite, resolved relative to THIS script so it works from any CWD.
DEFAULT_OUT = Path(__file__).resolve().parent.parent / "diff" / "test" / "fixtures" / "sample-golden.json"


def _git_sha() -> str:
    """Return the current commit SHA, or a placeholder if git is unavailable."""
    try:
        result = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            check=True,
            cwd=Path(__file__).resolve().parent,
        )
        return result.stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "0" * 40


def _stage_query_embedding(dim: int) -> dict:
    """Deterministic synthetic query embedding: a monotonic ramp [0.1, 0.2, ...].

    Real mode: replace with the sentence-transformers BGE query vector
    (CLS-pooled, L2-normalized) for the case query.
    """
    vector = [round((i + 1) * 0.1, 6) for i in range(dim)]
    return {"dim": dim, "vector": vector}


def _stage_retrieved_ids(top_k: int) -> list[str]:
    """Deterministic candidate node IDs n1..nK (ordered)."""
    return [f"n{i + 1}" for i in range(top_k)]


def _stage_reranked_ids(retrieved: list[str]) -> list[str]:
    """Illustrative deterministic rerank of the first three candidates.

    Real mode: replace with the cross-encoder reranker's ordering.
    """
    head = retrieved[:3]
    # Fixed permutation [2, 0, 1] -> e.g. ["n3", "n1", "n2"].
    order = [2, 0, 1]
    return [head[i] for i in order if i < len(head)]


def build_fixture(case_id: str, query: str, seed: int, top_k: int, dim: int) -> dict:
    retrieved = _stage_retrieved_ids(top_k)
    reranked = _stage_reranked_ids(retrieved)
    return {
        "schemaVersion": SCHEMA_VERSION,
        "provenance": {
            "gitSha": _git_sha(),
            "generatedAt": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
            "oracle": "agent-kgpacks-python (stub)",
            "models": MODELS,
            "bindingVersion": BINDING_VERSION,
            "storageVersion": STORAGE_VERSION,
        },
        "case": {
            "id": case_id,
            "query": query,
            "config": {"topK": top_k, "cosineThreshold": 0.999, "seed": seed},
        },
        "stages": {
            "queryEmbedding": _stage_query_embedding(dim),
            "retrievedIds": retrieved,
            "rerankedIds": reranked,
            "finalAnswer": {
                "citations": reranked[:2],
                "topK": reranked,
                "seed": seed,
                "text": STUB_ANSWER_TEXT,
            },
        },
    }


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Export a golden parity fixture (JSON).")
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="output JSON path")
    parser.add_argument("--case-id", default="sample-1", help="fixture case id")
    parser.add_argument("--query", default="What is a knowledge pack?", help="case query text")
    parser.add_argument("--seed", type=int, default=42, help="decoding seed")
    parser.add_argument("--top-k", type=int, default=5, help="number of retrieved candidates")
    parser.add_argument("--dim", type=int, default=8, help="query embedding dimensionality")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    fixture = build_fixture(
        case_id=args.case_id,
        query=args.query,
        seed=args.seed,
        top_k=args.top_k,
        dim=args.dim,
    )
    args.out.parent.mkdir(parents=True, exist_ok=True)
    with args.out.open("w", encoding="utf-8") as handle:
        json.dump(fixture, handle, indent=2)
        handle.write("\n")
    print(f"wrote {args.out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
