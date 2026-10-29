const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { PrismaAIEngine } = require('../dist/engine');

// ─── Helpers ─────────────────────────────────────────────────────────────────

const query = (filters = [], extras = {}) => ({
  targetTable: 'user',
  logicalOperator: 'AND',
  filters,
  ...extras,
});

// ─── 1. Core Parsing ─────────────────────────────────────────────────────────

describe('Core Parsing', () => {
  test('parses JSON string output into a Prisma where clause', () => {
    const result = PrismaAIEngine.parseDynamicQuery(JSON.stringify(query([
      { field: 'status', operator: 'equals', value: 'active' },
      { field: 'age', operator: 'gte', value: 18 },
    ])));

    assert.equal(result.targetTable, 'user');
    assert.deepEqual(result.where, {
      AND: [
        { status: { equals: 'active' } },
        { age: { gte: 18 } },
      ],
    });
  });

  test('accepts a plain object (not stringified) as input', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'email', operator: 'contains', value: '@example.com' },
    ]));

    assert.equal(result.targetTable, 'user');
    assert.deepEqual(result.where, {
      AND: [{ email: { contains: '@example.com' } }],
    });
  });

  test('defaults logicalOperator to AND when omitted', () => {
    const result = PrismaAIEngine.parseDynamicQuery({
      targetTable: 'user',
      filters: [{ field: 'email', operator: 'contains', value: '@example.com' }],
    });

    assert.deepEqual(result.where, {
      AND: [{ email: { contains: '@example.com' } }],
    });
  });

  test('returns an empty where clause when there are no filters', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query());
    assert.deepEqual(result.where, {});
  });

  test('supports OR as a logical operator', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'status', operator: 'equals', value: 'active' },
      { field: 'status', operator: 'equals', value: 'pending' },
    ], { logicalOperator: 'OR' }));

    assert.deepEqual(result.where, {
      OR: [
        { status: { equals: 'active' } },
        { status: { equals: 'pending' } },
      ],
    });
  });

  test('preserves the targetTable from input', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([], { targetTable: 'product' }));
    assert.equal(result.targetTable, 'product');
  });
});

// ─── 2. Input Validation ─────────────────────────────────────────────────────

describe('Input Validation', () => {
  test('rejects malformed JSON strings', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery('{not json'),
      /AI output was not valid JSON/,
    );
  });

  test('rejects an empty string', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(''),
      /AI output was not valid JSON/,
    );
  });

  test('rejects invalid Prisma operators via Zod', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { field: 'status', operator: 'delete', value: 'active' },
      ])),
    );
  });

  test('rejects SQL injection-style operator values', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { field: 'status', operator: 'DROP TABLE users;--', value: 'x' },
      ])),
    );
  });

  test('requires a non-empty target table', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([], { targetTable: '  ' })),
      /did not include a valid targetTable/,
    );
  });

  test('rejects missing targetTable (undefined)', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery({ filters: [], logicalOperator: 'AND' }),
      /did not include a valid targetTable/,
    );
  });

  test('validates all 11 Prisma operators are accepted', () => {
    const operators = [
      'equals', 'not', 'in', 'notIn', 'lt', 'lte',
      'gt', 'gte', 'contains', 'startsWith', 'endsWith',
    ];

    for (const operator of operators) {
      const value = (operator === 'in' || operator === 'notIn') ? [1] : 'test';
      const result = PrismaAIEngine.parseDynamicQuery(query([
        { field: 'col', operator, value },
      ]));
      assert.ok(result.where.AND, `operator '${operator}' should produce a valid where clause`);
    }
  });
});

// ─── 3. Security – blockList ─────────────────────────────────────────────────

describe('Security – blockList', () => {
  test('blocks an exact-match table name', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query(), { blockList: ['user'] }),
      /blocked table/,
    );
  });

  test('blocks a dot-notation descendant of a blocked table', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(
        query([], { targetTable: 'user.profile' }),
        { blockList: ['user'] },
      ),
      /blocked table/,
    );
  });

  test('does NOT block a table whose name merely starts with the blocked word', () => {
    // "username" starts with "user" but is NOT "user" nor "user.<something>"
    const result = PrismaAIEngine.parseDynamicQuery(
      query([], { targetTable: 'username' }),
      { blockList: ['user'] },
    );
    assert.equal(result.targetTable, 'username');
  });

  test('blocks an exact-match field name', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { field: 'password', operator: 'equals', value: 'secret' },
      ]), { blockList: ['password'] }),
      /blocked table or field/,
    );
  });

  test('blocks a dot-notation descendant of a blocked field', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { field: 'user.password.hash', operator: 'equals', value: 'x' },
      ]), { blockList: ['user.password'] }),
      /blocked table or field/,
    );
  });

  test('does NOT block a field whose name merely starts with the blocked word', () => {
    // "passwordHash" starts with "password" but is NOT "password" nor "password.<something>"
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'passwordHash', operator: 'equals', value: 'x' },
    ]), { blockList: ['password'] });

    assert.deepEqual(result.where, {
      AND: [{ passwordHash: { equals: 'x' } }],
    });
  });

  test('supports multiple entries in the blockList', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { field: 'creditCard', operator: 'equals', value: '4111' },
      ]), { blockList: ['password', 'creditCard'] }),
      /blocked table or field/,
    );
  });

  test('allows queries through when blockList has no matches', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'email', operator: 'equals', value: 'a@b.com' },
    ]), { blockList: ['password', 'creditCard'] });

    assert.deepEqual(result.where, {
      AND: [{ email: { equals: 'a@b.com' } }],
    });
  });
});

// ─── 4. Security – allowList ─────────────────────────────────────────────────

describe('Security – allowList', () => {
  

  test("blocks a table not on the allowList", () => {
    assert.throws(
      () =>
        PrismaAIEngine.parseDynamicQuery(query(), { allowList: ["product"] }),
      /non-allowlisted table/,
    );
  });

  test("allows a table that is on the allowList", () => {
    const result = PrismaAIEngine.parseDynamicQuery(query(), {
      allowList: ["user"],
    });
    assert.equal(result.targetTable, "user");
  });

  test("allows a dot-notation descendant of an allowlisted table", () => {
    const result = PrismaAIEngine.parseDynamicQuery(
      query([], { targetTable: "user.profile" }),
      { allowList: ["user"] },
    );
    assert.equal(result.targetTable, "user.profile");
  });

  test("blocks a field not on the allowList", () => {
    assert.throws(
      () =>
        PrismaAIEngine.parseDynamicQuery(
          query([{ field: "password", operator: "equals", value: "secret" }]),
          { allowList: ["user", "email"] },
        ), // Only 'email' is explicitly allowed under 'user'
      /non-allowlisted field/,
    );
  });

  test("allows a field that is on the allowList", () => {
    const result = PrismaAIEngine.parseDynamicQuery(
      query([{ field: "email", operator: "equals", value: "a@b.com" }]),
      { allowList: ["user", "email"] },
    );

    assert.deepEqual(result.where, {
      AND: [{ email: { equals: "a@b.com" } }],
    });
  });

  test("allows a dot-notation descendant of an allowlisted field and expands to nested Prisma filter", () => {
    const result = PrismaAIEngine.parseDynamicQuery(
      query([
        { field: "user.email", operator: "equals", value: "a@example.com" },
      ]),
      { allowList: ["user"] },
    );

    assert.deepEqual(result.where, {
      AND: [{ user: { email: { equals: "a@example.com" } } }],
    });
  });

  test("supports multiple entries in the allowList", () => {
    const result = PrismaAIEngine.parseDynamicQuery(
      query([
        { field: "email", operator: "equals", value: "a@b.com" },
        { field: "status", operator: "equals", value: "active" },
      ]),
      { allowList: ["user", "email", "status"] },
    );

    assert.deepEqual(result.where, {
      AND: [{ email: { equals: "a@b.com" } }, { status: { equals: "active" } }],
    });
  });
});

// ─── 5. Value Normalization – in / notIn ─────────────────────────────────────

describe('Value Normalization – in / notIn', () => {
  test('parses a JSON array string for "in" operator', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'id', operator: 'in', value: '[1,2,3]' },
    ]));
    assert.deepEqual(result.where.AND[0].id.in, [1, 2, 3]);
  });

  test('parses a comma-separated string for "notIn" operator', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'status', operator: 'notIn', value: 'inactive, archived' },
    ]));
    assert.deepEqual(result.where.AND[0].status.notIn, ['inactive', 'archived']);
  });

  test('preserves native arrays passed directly', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'id', operator: 'in', value: [1, 2] },
    ]));
    assert.deepEqual(result.where.AND[0].id.in, [1, 2]);
  });

  test('wraps a single non-array value in an array for "in"', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'id', operator: 'in', value: 42 },
    ]));
    assert.deepEqual(result.where.AND[0].id.in, [42]);
  });

  test('wraps a single string value in an array for "in"', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'tag', operator: 'in', value: 'featured' },
    ]));
    assert.deepEqual(result.where.AND[0].tag.in, ['featured']);
  });

  test('returns an empty array for an empty string value with "in"', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'tag', operator: 'in', value: '  ' },
    ]));
    assert.deepEqual(result.where.AND[0].tag.in, []);
  });

  test('handles a non-parseable JSON-like string for "in" via comma-split', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'id', operator: 'in', value: '[bad json' },
    ]));
    // Should not throw; falls back to wrapping in array
    assert.ok(Array.isArray(result.where.AND[0].id.in));
  });
});

// ─── 6. Value Normalization – Scalar JSON ────────────────────────────────────

describe('Value Normalization – Scalar JSON parsing', () => {
  test('parses a JSON object string into an object', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'metadata', operator: 'equals', value: '{"active":true}' },
    ]));
    assert.deepEqual(result.where.AND[0].metadata.equals, { active: true });
  });

  test('parses a JSON array string in a non-in operator', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'tags', operator: 'equals', value: '["a","b"]' },
    ]));
    assert.deepEqual(result.where.AND[0].tags.equals, ['a', 'b']);
  });

  test('keeps a plain string value as-is', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'name', operator: 'contains', value: 'John' },
    ]));
    assert.equal(result.where.AND[0].name.contains, 'John');
  });

  test('keeps a numeric value as-is', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'age', operator: 'gte', value: 21 },
    ]));
    assert.equal(result.where.AND[0].age.gte, 21);
  });

  test('keeps invalid JSON-shaped strings as-is', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'note', operator: 'equals', value: '{broken json' },
    ]));
    assert.equal(result.where.AND[0].note.equals, '{broken json');
  });

  test('passes through undefined value', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'deleted', operator: 'equals', value: undefined },
    ]));
    assert.equal(result.where.AND[0].deleted.equals, undefined);
  });

  test('passes through null value', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'deleted', operator: 'equals', value: null },
    ]));
    assert.equal(result.where.AND[0].deleted.equals, null);
  });

  test('passes through boolean value', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'isActive', operator: 'equals', value: true },
    ]));
    assert.equal(result.where.AND[0].isActive.equals, true);
  });

  test('does not attempt JSON parse on an empty string', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'name', operator: 'equals', value: '' },
    ]));
    assert.equal(result.where.AND[0].name.equals, '');
  });
});

// ─── 7. matchesSecurityRule Edge Cases ───────────────────────────────────────

describe('matchesSecurityRule edge cases', () => {
  test('trims whitespace on field and rule before comparison', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { field: '  password  ', operator: 'equals', value: 'x' },
      ]), { blockList: ['password'] }),
      /blocked table or field/,
    );
  });

  test('trims whitespace on table name', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(
        query([], { targetTable: '  user  ' }),
        { blockList: ['user'] },
      ),
      /blocked table/,
    );
  });

  test('empty blockList has no effect', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'password', operator: 'equals', value: 'x' },
    ]), { blockList: [] });
    assert.deepEqual(result.where, {
      AND: [{ password: { equals: 'x' } }],
    });
  });

  test('empty allowList blocks everything', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query(), { allowList: [] }),
      /non-allowlisted table/,
    );
  });
});

// ─── 8. Combined Scenarios ───────────────────────────────────────────────────

describe('Combined / integration scenarios', () => {
  test('multiple filters with different operators', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'name', operator: 'startsWith', value: 'J' },
      { field: 'age', operator: 'gt', value: 18 },
      { field: 'email', operator: 'endsWith', value: '@company.com' },
      { field: 'role', operator: 'not', value: 'admin' },
      { field: 'score', operator: 'lt', value: 100 },
      { field: 'level', operator: 'lte', value: 5 },
    ]));

    assert.equal(result.where.AND.length, 6);
    assert.deepEqual(result.where.AND[0], { name: { startsWith: 'J' } });
    assert.deepEqual(result.where.AND[1], { age: { gt: 18 } });
    assert.deepEqual(result.where.AND[2], { email: { endsWith: '@company.com' } });
    assert.deepEqual(result.where.AND[3], { role: { not: 'admin' } });
    assert.deepEqual(result.where.AND[4], { score: { lt: 100 } });
    assert.deepEqual(result.where.AND[5], { level: { lte: 5 } });
  });

  test('OR with security config passes through safely', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'status', operator: 'equals', value: 'active' },
      { field: 'role', operator: 'equals', value: 'admin' },
    ], { logicalOperator: 'OR' }), {
      allowList: ['user', 'status', 'role'],
    });

    assert.deepEqual(result.where, {
      OR: [
        { status: { equals: 'active' } },
        { role: { equals: 'admin' } },
      ],
    });
  });

  test('no config at all works for unrestricted access', () => {
    const result = PrismaAIEngine.parseDynamicQuery(query([
      { field: 'anything', operator: 'equals', value: 'val' },
    ]));

    assert.equal(result.targetTable, 'user');
    assert.deepEqual(result.where, {
      AND: [{ anything: { equals: 'val' } }],
    });
  });

  test('blockList on table takes precedence before fields are checked', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { field: 'email', operator: 'equals', value: 'a@b.com' },
      ]), { blockList: ['user'] }),
      /blocked table/,
    );
  });

  test('allowList on table takes precedence before fields are checked', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { field: 'email', operator: 'equals', value: 'a@b.com' },
      ]), { allowList: ['product'] }),
      /non-allowlisted table/,
    );
  });
});

// ─── 9. Zod Schema Validation ────────────────────────────────────────────────

describe('Zod schema validation', () => {
  test('rejects input missing the filters array', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery({ targetTable: 'user' }),
    );
  });

  test('rejects a filter missing the field property', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { operator: 'equals', value: 'x' },
      ])),
    );
  });

  test('rejects a filter missing the operator property', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([
        { field: 'name', value: 'x' },
      ])),
    );
  });

  test('rejects an invalid logicalOperator', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(query([], { logicalOperator: 'XOR' })),
    );
  });
});

// ─── 10. PrismaGeminiAgent (constructor tests, no network) ───────────────────

describe('PrismaGeminiAgent constructor', () => {
  // We can only test the constructor validation since actual Gemini calls need a real API key
  const { PrismaGeminiAgent } = require('../dist/agent');

  test('throws when no API key is provided and env is unset', () => {
    const originalKey = process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY;

    try {
      assert.throws(
        () => new PrismaGeminiAgent(),
        /GEMINI_API_KEY is missing/,
      );
    } finally {
      if (originalKey) process.env.GEMINI_API_KEY = originalKey;
    }
  });

  test('accepts an explicit API key without throwing', () => {
    assert.doesNotThrow(() => new PrismaGeminiAgent('test-api-key-123'));
  });

  test('uses GEMINI_API_KEY from environment when no explicit key is given', () => {
    const originalKey = process.env.GEMINI_API_KEY;
    process.env.GEMINI_API_KEY = 'env-test-key-456';

    try {
      assert.doesNotThrow(() => new PrismaGeminiAgent());
    } finally {
      if (originalKey) {
        process.env.GEMINI_API_KEY = originalKey;
      } else {
        delete process.env.GEMINI_API_KEY;
      }
    }
  });

  test('defaults model to gemini-3.1-flash-lite-preview when not specified', () => {
    const originalModel = process.env.GEMINI_MODEL;
    delete process.env.GEMINI_MODEL;

    try {
      const agent = new PrismaGeminiAgent('test-api-key');
      assert.equal(agent['model'], 'gemini-3.1-flash-lite-preview');
    } finally {
      if (originalModel) process.env.GEMINI_MODEL = originalModel;
    }
  });

  test('reads custom model from GEMINI_MODEL environment variable', () => {
    const originalModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_MODEL = 'gemini-2.5-flash';

    try {
      const agent = new PrismaGeminiAgent('test-api-key');
      assert.equal(agent['model'], 'gemini-2.5-flash');
    } finally {
      if (originalModel) {
        process.env.GEMINI_MODEL = originalModel;
      } else {
        delete process.env.GEMINI_MODEL;
      }
    }
  });

  test('constructor model argument takes precedence over GEMINI_MODEL env', () => {
    const originalModel = process.env.GEMINI_MODEL;
    process.env.GEMINI_MODEL = 'gemini-env-model';

    try {
      const agent = new PrismaGeminiAgent('test-api-key', 'gemini-1.5-pro');
      assert.equal(agent['model'], 'gemini-1.5-pro');
    } finally {
      if (originalModel) {
        process.env.GEMINI_MODEL = originalModel;
      } else {
        delete process.env.GEMINI_MODEL;
      }
    }
  });

  test('passes the configured model to generateContent call', async () => {
    const agent = new PrismaGeminiAgent('test-api-key', 'gemini-custom-model-v1');
    let capturedModel = null;

    // Mock internal ai.models.generateContent
    agent['ai'] = {
      models: {
        generateContent: async (params) => {
          capturedModel = params.model;
          return {
            text: JSON.stringify({
              targetTable: 'user',
              logicalOperator: 'AND',
              filters: [{ field: 'status', operator: 'equals', value: 'active' }],
            }),
          };
        },
      },
    };

    const res = await agent.generateSafeQuery('show active users');
    assert.equal(capturedModel, 'gemini-custom-model-v1');
    assert.equal(res.targetTable, 'user');
    assert.deepEqual(res.where, {
      AND: [{ status: { equals: 'active' } }],
    });
  });
});

// ─── 11. Exports ─────────────────────────────────────────────────────────────

describe('Package exports', () => {
  const index = require('../dist/index');

  test('exports PrismaAIEngine', () => {
    assert.equal(typeof index.PrismaAIEngine, 'function');
  });

  test('exports PrismaGeminiAgent', () => {
    assert.equal(typeof index.PrismaGeminiAgent, 'function');
  });

  test('exports AIQueryResponseSchema (Zod schema)', () => {
    assert.ok(index.AIQueryResponseSchema);
    assert.equal(typeof index.AIQueryResponseSchema.parse, 'function');
  });

  test('exports PrismaOperatorSchema (Zod enum)', () => {
    assert.ok(index.PrismaOperatorSchema);
    assert.equal(typeof index.PrismaOperatorSchema.parse, 'function');
  });

  test('exports introspect utilities', () => {
    assert.equal(typeof index.extractPrismaSchema, 'function');
    assert.equal(typeof index.parsePrismaSchemaText, 'function');
    assert.equal(typeof index.formatSchemaForAIContext, 'function');
  });

  test('PrismaOperatorSchema accepts all valid operators', () => {
    const ops = [
      'equals', 'not', 'in', 'notIn', 'lt', 'lte', 'gt', 'gte', 
      'contains', 'startsWith', 'endsWith', 'some', 'every', 'none', 'is', 'isNot'
    ];
    for (const op of ops) {
      assert.doesNotThrow(() => index.PrismaOperatorSchema.parse(op));
    }
  });

  test('PrismaOperatorSchema rejects invalid operators', () => {
    assert.throws(() => index.PrismaOperatorSchema.parse('drop'));
    assert.throws(() => index.PrismaOperatorSchema.parse('delete'));
  });
});

// ─── 12. Multi-Level Queries (include, select, orderBy, take) ────────────────

describe('Multi-Level Queries', () => {
  test('parses multi-level include queries with relations', () => {
    const raw = {
      targetTable: 'subscription',
      logicalOperator: 'AND',
      filters: [{ field: 'status', operator: 'equals', value: 'inactive' }],
      include: {
        user: {
          include: {
            loginAttempts: {
              take: 1,
              orderBy: { createdAt: 'desc' }
            }
          }
        }
      },
      take: 10,
      skip: 0
    };

    const parsed = PrismaAIEngine.parseDynamicQuery(raw);
    assert.equal(parsed.targetTable, 'subscription');
    assert.deepEqual(parsed.where, {
      AND: [{ status: { equals: 'inactive' } }]
    });
    assert.deepEqual(parsed.include, {
      user: {
        include: {
          loginAttempts: {
            take: 1,
            orderBy: { createdAt: 'desc' }
          }
        }
      }
    });
    assert.equal(parsed.take, 10);
    assert.equal(parsed.skip, 0);
  });

  test('blocks sensitive fields in nested include / select via blockList', () => {
    const raw = {
      targetTable: 'subscription',
      logicalOperator: 'AND',
      filters: [],
      include: {
        user: {
          select: {
            passwordHash: true,
            email: true
          }
        }
      }
    };

    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(raw, { blockList: ['passwordHash'] }),
      /blocked table or field/
    );
  });

  test('blocks dot-notation relational path inside include', () => {
    const raw = {
      targetTable: 'subscription',
      logicalOperator: 'AND',
      filters: [],
      include: {
        user: {
          select: {
            privateMeta: true
          }
        }
      }
    };

    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery(raw, { blockList: ['user.privateMeta'] }),
      /blocked table or field/
    );
  });

  test('sanitizes select and orderBy parameters safely', () => {
    const raw = {
      targetTable: 'user',
      logicalOperator: 'AND',
      filters: [{ field: 'role', operator: 'equals', value: 'subscriber' }],
      select: {
        id: true,
        fullName: true,
        email: true
      },
      orderBy: { createdAt: 'desc' }
    };

    const parsed = PrismaAIEngine.parseDynamicQuery(raw);
    assert.deepEqual(parsed.select, {
      id: true,
      fullName: true,
      email: true
    });
    assert.deepEqual(parsed.orderBy, { createdAt: 'desc' });
  });

  test('gracefully handles take when Gemini outputs 0, negative, null, or string numbers', () => {
    // When take is 0, it should be sanitized to undefined so Prisma does not error
    const zeroTake = PrismaAIEngine.parseDynamicQuery({
      targetTable: 'user',
      filters: [],
      take: 0
    });
    assert.equal(zeroTake.take, undefined);

    // Negative take
    const negTake = PrismaAIEngine.parseDynamicQuery({
      targetTable: 'user',
      filters: [],
      take: -5
    });
    assert.equal(negTake.take, undefined);

    // String number "25"
    const strTake = PrismaAIEngine.parseDynamicQuery({
      targetTable: 'user',
      filters: [],
      take: '25'
    });
    assert.equal(strTake.take, 25);

    // Null take
    const nullTake = PrismaAIEngine.parseDynamicQuery({
      targetTable: 'user',
      filters: [],
      take: null
    });
    assert.equal(nullTake.take, undefined);
  });

  test('coerces string numbers to integers when comparing numeric fields', () => {
    // 1. Automatic schema-guided coercion
    const mockSchema = {
      models: [
        {
          name: 'User',
          fields: [
            { name: 'id', type: 'Int', isList: false, isRequired: true },
            { name: 'age', type: 'Int', isList: false, isRequired: true },
            { name: 'balance', type: 'Float', isList: false, isRequired: true },
            { name: 'isActive', type: 'Boolean', isList: false, isRequired: true },
            { name: 'email', type: 'String', isList: false, isRequired: true }
          ]
        }
      ],
      enums: []
    };

    const res = PrismaAIEngine.parseDynamicQuery({
      targetTable: 'user',
      filters: [
        { field: 'id', operator: 'equals', value: '1' },
        { field: 'age', operator: 'gte', value: '25' },
        { field: 'balance', operator: 'gt', value: '99.50' },
        { field: 'isActive', operator: 'equals', value: 'true' },
        { field: 'email', operator: 'equals', value: '123@example.com' }
      ]
    }, { schemaContext: mockSchema });

    // Int values should be numbers, not strings
    assert.strictEqual(res.where.AND[0].id.equals, 1);
    assert.strictEqual(res.where.AND[1].age.gte, 25);
    // Float values should be numbers
    assert.strictEqual(res.where.AND[2].balance.gt, 99.5);
    // Boolean should be boolean
    assert.strictEqual(res.where.AND[3].isActive.equals, true);
    // String remains String even if it starts with digits
    assert.strictEqual(res.where.AND[4].email.equals, '123@example.com');
  });

  test('coerces integer strings in in/notIn arrays when expected type is Int', () => {
    const mockSchema = {
      models: [
        {
          name: 'Subscription',
          fields: [
            { name: 'id', type: 'Int', isList: false, isRequired: true },
            { name: 'userId', type: 'Int', isList: false, isRequired: true }
          ]
        }
      ],
      enums: []
    };

    const res = PrismaAIEngine.parseDynamicQuery({
      targetTable: 'subscription',
      filters: [
        { field: 'id', operator: 'in', value: '["1", "2", "3"]' },
        { field: 'userId', operator: 'in', value: '10, 20, 30' }
      ]
    }, { schemaContext: mockSchema });

    assert.deepEqual(res.where.AND[0].id.in, [1, 2, 3]);
    assert.deepEqual(res.where.AND[1].userId.in, [10, 20, 30]);
  });

  test('PrismaAIEngine.filterBlockedData strips blocked fields recursively from records', () => {
    const rawData = [
      {
        id: 1,
        email: 'user@example.com',
        password: 'hashed_password_123',
        privateToken: 'token_xyz',
        profile: {
          bio: 'Hello world',
          ssn: '123-45-6789'
        }
      }
    ];

    const cleaned = PrismaAIEngine.filterBlockedData(rawData, {
      blockList: ['password', 'profile.ssn']
    });

    assert.deepEqual(cleaned, [
      {
        id: 1,
        email: 'user@example.com',
        privateToken: 'token_xyz',
        profile: {
          bio: 'Hello world'
        }
      }
    ]);
  });
});

// ─── 13. Schema Extraction & Introspection ───────────────────────────────────

describe('Schema Extraction & Introspection', () => {
  const { parsePrismaSchemaText, formatSchemaForAIContext } = require('../dist/introspect');

  const sampleSchema = `
    datasource db {
      provider = "postgresql"
      url      = env("DATABASE_URL")
    }

    generator client {
      provider = "prisma-client-js"
    }

    enum SubscriptionStatus {
      ACTIVE
      INACTIVE
      CANCELLED
    }

    model User {
      id            Int            @id @default(autoincrement())
      email         String         @unique
      fullName      String
      subscriptions Subscription[]
      loginAttempts LoginAttempt[]
      createdAt     DateTime       @default(now())
    }

    model Subscription {
      id        Int                @id @default(autoincrement())
      status    SubscriptionStatus
      userId    Int
      user      User               @relation(fields: [userId], references: [id])
      createdAt DateTime           @default(now())
    }

    model LoginAttempt {
      id        Int      @id @default(autoincrement())
      userId    Int
      success   Boolean
      createdAt DateTime @default(now())
      user      User     @relation(fields: [userId], references: [id])
    }
  `;

  test('parses models, fields, types, and enums accurately while ignoring datasources and generators', () => {
    const extracted = parsePrismaSchemaText(sampleSchema);

    // Enums
    assert.equal(extracted.enums.length, 1);
    assert.equal(extracted.enums[0].name, 'SubscriptionStatus');
    assert.deepEqual(extracted.enums[0].values, ['ACTIVE', 'INACTIVE', 'CANCELLED']);

    // Models
    assert.equal(extracted.models.length, 3);
    const userModel = extracted.models.find(m => m.name === 'User');
    assert.ok(userModel);
    assert.ok(userModel.fields.some(f => f.name === 'email' && f.type === 'String'));
    assert.ok(userModel.fields.some(f => f.name === 'subscriptions' && f.isList));
    assert.ok(userModel.fields.some(f => f.name === 'loginAttempts' && f.isList));
  });

  test('formats extracted schema into a compact AI context prompt string', () => {
    const extracted = parsePrismaSchemaText(sampleSchema);
    const formatted = formatSchemaForAIContext(extracted);

    assert.ok(formatted.includes('Model User'));
    assert.ok(formatted.includes('Model Subscription'));
    assert.ok(formatted.includes('Model LoginAttempt'));
    assert.ok(formatted.includes('Enum SubscriptionStatus [ACTIVE, INACTIVE, CANCELLED]'));
    assert.ok(!formatted.includes('DATABASE_URL')); // sensitive datasource omitted
  });
});

// ─── 14. Natural Language Response Resolution ───────────────────────────────

describe('Natural Language Response Configuration & Formatting', () => {
  const { PrismaGeminiAgent } = require('../dist/agent');

  test('defaults to true when env is not set', () => {
    const originalEnv = process.env.NATURAL_LANGUAGE_RESPONSE;
    delete process.env.NATURAL_LANGUAGE_RESPONSE;

    try {
      const agent = new PrismaGeminiAgent('dummy-key');
      assert.equal(agent.isNaturalLanguageEnabled(), true);
    } finally {
      if (originalEnv) process.env.NATURAL_LANGUAGE_RESPONSE = originalEnv;
    }
  });

  test('reads false from NATURAL_LANGUAGE_RESPONSE env variable', () => {
    const originalEnv = process.env.NATURAL_LANGUAGE_RESPONSE;
    process.env.NATURAL_LANGUAGE_RESPONSE = 'false';

    try {
      const agent = new PrismaGeminiAgent('dummy-key');
      assert.equal(agent.isNaturalLanguageEnabled(), false);
    } finally {
      if (originalEnv) {
        process.env.NATURAL_LANGUAGE_RESPONSE = originalEnv;
      } else {
        delete process.env.NATURAL_LANGUAGE_RESPONSE;
      }
    }
  });

  test('config object overrides environment variable', () => {
    const originalEnv = process.env.NATURAL_LANGUAGE_RESPONSE;
    process.env.NATURAL_LANGUAGE_RESPONSE = 'false';

    try {
      const agent = new PrismaGeminiAgent('dummy-key');
      assert.equal(agent.isNaturalLanguageEnabled({ naturalLanguageResponse: true }), true);
      assert.equal(agent.isNaturalLanguageEnabled({ naturalLanguageResponse: false }), false);
    } finally {
      if (originalEnv) {
        process.env.NATURAL_LANGUAGE_RESPONSE = originalEnv;
      } else {
        delete process.env.NATURAL_LANGUAGE_RESPONSE;
      }
    }
  });

  test('executes query and returns natural language summary when enabled', async () => {
    const agent = new PrismaGeminiAgent('dummy-key');

    // Mock AI calls
    agent['ai'] = {
      models: {
        generateContent: async (params) => {
          // Schema query generation call
          if (params.config?.responseSchema) {
            return {
              text: JSON.stringify({
                targetTable: 'subscription',
                logicalOperator: 'AND',
                filters: [{ field: 'status', operator: 'equals', value: 'inactive' }],
                include: { user: true }
              })
            };
          }
          // Natural language summary call
          return {
            text: 'There is only one inactive subscriber and the full name is Kate Michael and his last logged In date is 28th April 2026'
          };
        }
      }
    };

    // Mock Prisma Client
    const mockDbData = [
      { id: 1, status: 'inactive', user: { fullName: 'Kate Michael' } }
    ];
    const mockPrisma = {
      subscription: {
        findMany: async () => mockDbData
      }
    };

    const res = await agent.execute(
      'who are the inactive subscribers',
      mockPrisma,
      { naturalLanguageResponse: true }
    );

    assert.deepEqual(res.data, mockDbData);
    assert.equal(
      res.naturalLanguage,
      'There is only one inactive subscriber and the full name is Kate Michael and his last logged In date is 28th April 2026'
    );
    assert.equal(res.query.targetTable, 'subscription');
  });

  test('executes query and returns ONLY raw structured data when natural language is false', async () => {
    const agent = new PrismaGeminiAgent('dummy-key');

    agent['ai'] = {
      models: {
        generateContent: async () => ({
          text: JSON.stringify({
            targetTable: 'user',
            logicalOperator: 'AND',
            filters: []
          })
        })
      }
    };

    const mockDbData = [{ id: 1, fullName: 'Alex' }];
    const mockPrisma = {
      user: {
        findMany: async () => mockDbData
      }
    };

    const res = await agent.execute(
      'show users',
      mockPrisma,
      { naturalLanguageResponse: false }
    );

    assert.deepEqual(res.data, mockDbData);
    assert.equal(res.naturalLanguage, undefined); // No natural language when false
  });
});

// ---------------------------------------------------------------------------
// 15. End-to-End Multi-Level Relational Traversal & FK Auto-Stitching
// ---------------------------------------------------------------------------
describe('Multi-Level Relational Traversal (Subscription -> User -> LoginAttempt)', () => {
  const { PrismaGeminiAgent } = require('../dist/agent');
  const { parsePrismaSchemaText } = require('../dist/introspect');

  const multiLevelSchemaText = `
    enum SubscriptionStatus {
      ACTIVE
      INACTIVE
    }
    model User {
      id            Int            @id @default(autoincrement())
      fullName      String
      email         String
      passwordHash  String
      subscriptions Subscription[]
      loginAttempts LoginAttempt[]
    }
    model Subscription {
      id        Int                @id @default(autoincrement())
      status    SubscriptionStatus
      userId    Int
      user      User               @relation(fields: [userId], references: [id])
    }
    model LoginAttempt {
      id        Int      @id @default(autoincrement())
      userId    Int
      createdAt DateTime @default(now())
      user      User     @relation(fields: [userId], references: [id])
    }
  `;

  test('normalizes lowercase enum filter ("inactive" -> "INACTIVE") and parses stringified multi-level include from Gemini', () => {
    const schemaContext = parsePrismaSchemaText(multiLevelSchemaText);
    const parsed = PrismaAIEngine.parseDynamicQuery({
      targetTable: 'subscription',
      logicalOperator: 'AND',
      filters: [{ field: 'status', operator: 'equals', value: 'inactive' }],
      include: JSON.stringify({
        user: {
          include: {
            loginAttempts: {
              take: 1,
              orderBy: { createdAt: 'desc' }
            }
          }
        }
      })
    }, { schemaContext });

    assert.equal(parsed.targetTable, 'subscription');
    assert.deepEqual(parsed.where, {
      AND: [{ status: { equals: 'INACTIVE' } }]
    });
    assert.deepEqual(parsed.include, {
      user: {
        include: {
          loginAttempts: {
            take: 1,
            orderBy: { createdAt: 'desc' }
          }
        }
      }
    });
  });

  test('blocks unauthorized fields inside orderBy', () => {
    assert.throws(
      () => PrismaAIEngine.parseDynamicQuery({
        targetTable: 'user',
        filters: [],
        orderBy: { passwordHash: 'desc' }
      }, { blockList: ['passwordHash'] }),
      /blocked table or field/
    );
  });

  test('auto-stitches User and latest LoginAttempt via userId when schema relations are omitted', async () => {
    const agent = new PrismaGeminiAgent('dummy-key');

    // Simulate AI returning a flat query on subscription without nested include
    agent['ai'] = {
      models: {
        generateContent: async (params) => {
          if (params.config?.responseSchema) {
            return {
              text: JSON.stringify({
                targetTable: 'subscription',
                logicalOperator: 'AND',
                filters: [{ field: 'status', operator: 'equals', value: 'inactive' }]
              })
            };
          }
          return {
            text: 'Kate Michael is the only inactive subscriber, and her last login attempt was on 2026-04-28.'
          };
        }
      }
    };

    const mockPrisma = {
      subscription: {
        findMany: async () => [{ id: 10, status: 'inactive', userId: 42 }]
      },
      user: {
        findMany: async ({ where }) => {
          assert.deepEqual(where, { id: { in: [42] } });
          return [{ id: 42, fullName: 'Kate Michael', passwordHash: 'secret_hash' }];
        }
      },
      loginAttempt: {
        findMany: async ({ where }) => {
          assert.deepEqual(where, { userId: { in: [42] } });
          return [
            { id: 100, userId: 42, createdAt: '2026-04-28T12:00:00Z' },
            { id: 99, userId: 42, createdAt: '2026-04-01T08:00:00Z' }
          ];
        }
      }
    };

    const res = await agent.execute(
      'who are the inactive subscribers on the database and tell me their full names and their last login attempt',
      mockPrisma,
      { blockList: ['passwordHash'] }
    );

    assert.equal(res.data.length, 1);
    assert.equal(res.data[0].user.fullName, 'Kate Michael');
    // Verify blocked field was stripped from stitched user object
    assert.equal(res.data[0].user.passwordHash, undefined);
    // Verify only the latest login attempt was stitched
    assert.equal(res.data[0].user.loginAttempts.length, 1);
    assert.equal(res.data[0].user.loginAttempts[0].id, 100);
  });
});
