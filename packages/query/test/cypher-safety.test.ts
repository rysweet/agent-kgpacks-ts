// packages/query/test/cypher-safety.test.ts
//
// Parity + adversarial tests for validateCypher (read-only Cypher allow-list).
//
// The "allowed" and "rejected" base cases are ported verbatim from the Python
// reference security suite (rysweet/agent-kgpacks
// tests/agent/test_validate_cypher.py, PR #180). Additional adversarial negatives
// cover the remaining blocked keywords, stacked-statement injection, case/comment
// evasion, and variable-length path forms.

import { describe, expect, it } from 'vitest';

import { CypherValidationError, validateCypher } from '../src/index.js';

describe('validateCypher — allowed read-only queries (Python parity)', () => {
  it('allows a MATCH query', () => {
    expect(() => validateCypher('MATCH (a:Article) RETURN a LIMIT 10')).not.toThrow();
  });

  it('allows a CALL QUERY_VECTOR_INDEX query', () => {
    expect(() =>
      validateCypher(
        "CALL QUERY_VECTOR_INDEX('Section', 'embedding_idx', $query, 10) " +
          'RETURN node.title, node.content, score',
      ),
    ).not.toThrow();
  });

  it('allows a relationship traversal with LIMIT', () => {
    expect(() =>
      validateCypher(
        'MATCH (a:Article)-[:HAS_SECTION]->(s:Section) ' +
          'RETURN a.title, s.heading, s.content LIMIT 25',
      ),
    ).not.toThrow();
  });

  it('ignores blocked keywords inside double-quoted string literals', () => {
    expect(() =>
      validateCypher('MATCH (a:Article) WHERE a.name = "DELETE ME" RETURN a'),
    ).not.toThrow();
  });

  it('ignores blocked keywords inside single-quoted string literals', () => {
    expect(() =>
      validateCypher("MATCH (a:Article) WHERE a.note = 'CREATE later' RETURN a"),
    ).not.toThrow();
  });
});

describe('validateCypher — blocked write/DDL keywords (Python parity)', () => {
  const cases: ReadonlyArray<[string, string, RegExp]> = [
    [
      'CREATE',
      "MATCH (a:Article) CREATE (b:Article {title: 'hack'})",
      /Write operation rejected.*CREATE/,
    ],
    ['DELETE', 'MATCH (a:Article) DELETE a', /Write operation rejected.*DELETE/],
    ['DROP', 'MATCH (a:Article) DROP a', /Write operation rejected.*DROP/],
    ['SET', "MATCH (a:Article) SET a.title = 'pwned'", /Write operation rejected.*SET/],
  ];

  for (const [name, cypher, message] of cases) {
    it(`rejects ${name}`, () => {
      expect(() => validateCypher(cypher)).toThrow(CypherValidationError);
      expect(() => validateCypher(cypher)).toThrow(message);
    });
  }
});

describe('validateCypher — prefix and path validation (Python parity)', () => {
  it('rejects a non-MATCH/CALL prefix', () => {
    expect(() => validateCypher('RETURN 1 AS one')).toThrow(/must start with MATCH/);
  });

  it('rejects an unbounded variable-length path', () => {
    expect(() => validateCypher('MATCH (a)-[:LINKS_TO*]->(b) RETURN b LIMIT 10')).toThrow(
      /Unbounded variable-length path/,
    );
  });
});

describe('validateCypher — adversarial negatives', () => {
  it('rejects the remaining blocked keywords (MERGE/REMOVE/DETACH)', () => {
    expect(() => validateCypher("MATCH (a) MERGE (b:Article {title: 'x'})")).toThrow(
      /Write operation rejected.*MERGE/,
    );
    expect(() => validateCypher('MATCH (a:Article) REMOVE a.title')).toThrow(
      /Write operation rejected.*REMOVE/,
    );
    // DETACH precedes DELETE in token order, so it is the reported keyword.
    expect(() => validateCypher('MATCH (a:Article) DETACH DELETE a')).toThrow(
      /Write operation rejected.*DETACH/,
    );
  });

  it('rejects stacked-statement injection that smuggles a write', () => {
    expect(() => validateCypher('MATCH (a) RETURN a; DROP TABLE Article')).toThrow(
      /Write operation rejected.*DROP/,
    );
  });

  it('rejects case-evasion of a blocked keyword', () => {
    expect(() => validateCypher('mAtCh (a) cReAtE (b:Article) RETURN a')).toThrow(
      /Write operation rejected.*CREATE/,
    );
  });

  it('rejects a blocked keyword smuggled in a line comment', () => {
    expect(() => validateCypher('MATCH (a) //DELETE\nRETURN a')).toThrow(
      /Write operation rejected.*DELETE/,
    );
  });

  it('rejects BOUNDED variable-length paths too (strict regex parity)', () => {
    // The reference regex matches any `[...*...]`, so bounded forms are also
    // rejected — failing closed is the intended, parity-faithful behavior.
    expect(() => validateCypher('MATCH (a)-[:LINKS_TO*1..3]->(b) RETURN b')).toThrow(
      /Unbounded variable-length path/,
    );
  });

  it('throws CypherValidationError (a QueryError subclass) for every rejection', () => {
    try {
      validateCypher('MATCH (a:Article) DELETE a');
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(CypherValidationError);
    }
  });
});
