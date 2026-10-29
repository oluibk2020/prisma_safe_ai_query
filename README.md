# 🛡️ Prisma Safe AI Query

[![npm version](https://img.shields.io/npm/v/prisma-safe-ai-query.svg?color=blue)](https://www.npmjs.com/package/prisma-safe-ai-query)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![Build & Tests](https://img.shields.io/badge/tests-89%20passing-brightgreen.svg)](https://github.com/gbengataiwo)

> **Translate Natural Language into Safe, Typed, Multi-Level Prisma Queries with Google Gemini.**

Eliminate backend AI prompt engineering, parsing logic, and SQL injection risks. `prisma-safe-ai-query` takes user prompts (e.g., *"Who are the inactive subscribers and what were their last login attempts?"*), auto-inspects your Prisma schema, and generates fully structured, nested Prisma queries with dynamic table targeting, recursive field security, and type enforcement.

---

## 📑 Table of Contents

- [🛡️ Prisma Safe AI Query](#️-prisma-safe-ai-query)
  - [📑 Table of Contents](#-table-of-contents)
  - [⚡ Why Prisma Safe AI Query?](#-why-prisma-safe-ai-query)
  - [🏗️ Architecture Overview](#️-architecture-overview)
  - [📦 Installation](#-installation)
  - [⚙️ Environment Setup](#️-environment-setup)
  - [💬 Natural Language vs. Raw Structured Response](#-natural-language-vs-raw-structured-response)
  - [🖥️ Backend Setup (Next.js, Express, Fastify)](#️-backend-setup-nextjs-express-fastify)
    - [Next.js App Router (`app/api/chat-query/route.ts`)](#nextjs-app-router-appapichat-queryroutets)
    - [Express.js Example (`server.ts` or `server.js`)](#expressjs-example-serverts-or-serverjs)
  - [🎨 Frontend Integration (React, Vue.js)](#-frontend-integration-react-vuejs)
    - [1. React / Next.js Client Component](#1-react--nextjs-client-component)
  - [🔗 Multi-Level Relational Queries](#-multi-level-relational-queries)
  - [🧬 Zero-Config Schema Introspection](#-zero-config-schema-introspection)
    - [Privacy \& Security Guarantee](#privacy--security-guarantee)
  - [🔒 Security \& Access Control](#-security--access-control)
    - [Fail-Closed Behavior](#fail-closed-behavior)
  - [🤖 Dynamic Gemini Model Selection](#-dynamic-gemini-model-selection)
  - [🛠️ Standalone Parser for Custom LLMs](#️-standalone-parser-for-custom-llms)
  - [📖 API Reference](#-api-reference)
    - [`new PrismaGeminiAgent(apiKey?: string, model?: string)`](#new-prismageminiagentapikey-string-model-string)
    - [`agent.generateSafeQuery(prompt: string, config?: AgentConfig)`](#agentgeneratesafequeryprompt-string-config-agentconfig)
    - [`agent.execute(prompt: string, prismaClient: PrismaClient, config?: AgentConfig)`](#agentexecute-prompt-string-prismaclient-prismaclient-config-agentconfig)
    - [Standalone schema utilities](#standalone-schema-utilities)
    - [Returns `ParsedDynamicQuery`:](#returns-parseddynamicquery)
  - [📄 License](#-license)

---

## ⚡ Why Prisma Safe AI Query?

- **Zero SQL / Raw Injection Risk**: Never executes unvalidated strings or concatenated queries. Outputs strictly validated Prisma query AST objects (`where`, `include`, `select`, `orderBy`, `take`).
- **Multi-Level Relational Queries**: Connects multiple models automatically (e.g., `Subscription` -> `User` -> `LoginAttempts`).
- **Zero-Config Schema Introspection**: Reads your `schema.prisma` automatically without sending sensitive credentials or database URLs to the AI.
- **Deep Recursive Security**: Blocks unauthorized columns and relational paths (like `passwordHash` or `user.privateMeta`) across root and nested levels.
- **Universal Compatibility**: Works out of the box with `@prisma/client` (`v5.x`, `v6.x`, `v7.x+`) and Zod (`v3.x` & `v4.x`).

---

## 🏗️ Architecture Overview

```
User (Browser Chat UI)
  │
  ▼ POST /api/ai-query { prompt: "Show inactive subscribers and their last login" }
Backend API Route
  │
  ├─► PrismaGeminiAgent.execute(prompt, prisma)
  │     ├── 1. Auto-introspects schema.prisma (models, fields, relations)
  │     ├── 2. Calls Google Gemini (structured JSON mode)
  │     └── 3. Validates with Zod & enforces blockList/allowList recursively
  │
  ├─► Prisma Client findMany execution
  └─► Optional natural-language summary
  │
  ▼ Returns: { data, query, naturalLanguage? }
Frontend Render
```

---

## 📦 Installation

```bash
npm install prisma-safe-ai-query
```

> **Requirements:** Ensure your project has `@prisma/client` (`>=5.0.0`) and `zod` installed.

---

## ⚙️ Environment Setup

Add your Gemini credentials and optional model selection to your `.env` file:

```env
# Required: Get a free API key at https://aistudio.google.com/
GEMINI_API_KEY=your_gemini_api_key_here

# Optional: Choose a Gemini model (defaults to gemini-3.1-flash-lite-preview)
GEMINI_MODEL=gemini-2.5-flash

# Optional: Return a human-like conversational answer alongside structured data (defaults to true)
# Set to false to return ONLY raw database records
NATURAL_LANGUAGE_RESPONSE=true
```

---

## 💬 Natural Language vs. Raw Structured Response

`prisma-safe-ai-query` gives you the best of both worlds:

- **When `NATURAL_LANGUAGE_RESPONSE=true` (Default)**:  
  Returns conversational human text answering the prompt **plus** the raw database records:
  > *"There is only one inactive subscriber and the full name is Kate Michael and his last logged In date is 28th April 2026"*
- **When `NATURAL_LANGUAGE_RESPONSE=false`**:  
  Bypasses the second AI pass and returns **only** the exact structured JSON records from Prisma.

You can also toggle this dynamically per request in code:

```typescript
// Explicit override in code:
const result = await aiAgent.execute(userPrompt, prisma, {
  naturalLanguageResponse: false // forces raw database results only
});
```

The `execute()` result contains the structured `data` and sanitized `query`. When natural language output is enabled, it also contains `naturalLanguage`. This method executes a Prisma `findMany` call, so the supplied Prisma client must expose a delegate for the selected model.

---

## 🖥️ Backend Setup (Next.js, Express, Fastify)

Here is a full backend API route demonstrating how to receive a prompt, translate it, and execute it across dynamic tables.

### Next.js App Router (`app/api/chat-query/route.ts`)

```typescript
import { NextResponse } from 'next/server';
import { PrismaGeminiAgent } from 'prisma-safe-ai-query';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const aiAgent = new PrismaGeminiAgent();

export async function POST(req: Request) {
  try {
    const { prompt } = await req.json();

    if (!prompt) {
      return NextResponse.json({ error: "Prompt is required" }, { status: 400 });
    }

    // Single one-liner: generates safe query, executes on Prisma, and formats response
    const result = await aiAgent.execute(prompt, prisma, {
      blockList: ['password', 'passwordHash', 'creditCard', 'refreshToken']
    });

    return NextResponse.json({
      targetTable: result.query.targetTable,
      data: result.data,
      naturalLanguage: result.naturalLanguage // e.g. "There is only one inactive subscriber..."
    });

  } catch (error: any) {
    return NextResponse.json(
      { error: error.message || "Query generation failed" },
      { status: 400 }
    );
  }
}
```

### Express.js Example (`server.ts` or `server.js`)

**Using TypeScript or JavaScript (ES Modules):**

```javascript
import express from 'express';
import { PrismaGeminiAgent } from 'prisma-safe-ai-query';
import { PrismaClient } from '@prisma/client';

const app = express();
app.use(express.json());

const prisma = new PrismaClient();
const aiAgent = new PrismaGeminiAgent();

app.post('/api/chat-query', async (req, res) => {
  try {
    const { prompt } = req.body;

    // Single call: generates query, executes on Prisma, and returns data + naturalLanguage
    const result = await aiAgent.execute(prompt, prisma, {
      blockList: ['password', 'secretToken', 'refreshToken']
    });

    res.json({
      targetTable: result.query.targetTable,
      data: result.data,
      naturalLanguage: result.naturalLanguage // e.g. "There is only one inactive subscriber..."
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
```

**Using Node.js CommonJS (`require`):**

```javascript
const express = require('express');
const { PrismaGeminiAgent } = require('prisma-safe-ai-query');
const { PrismaClient } = require('@prisma/client');

const app = express();
app.use(express.json());

const prisma = new PrismaClient();
const aiAgent = new PrismaGeminiAgent();

app.post('/api/chat-query', async (req, res) => {
  try {
    const { prompt } = req.body;

    const result = await aiAgent.execute(prompt, prisma, {
      blockList: ['password', 'creditCard']
    });

    res.json({
      targetTable: result.query.targetTable,
      data: result.data,
      naturalLanguage: result.naturalLanguage
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.listen(3000, () => console.log('Server running on port 3000'));
```

---

## 🎨 Frontend Integration (React, Vue.js)

Because database operations must run securely on your server, your frontend connects to your backend API endpoint.

### 1. React / Next.js Client Component

```tsx
import React, { useState } from 'react';

export default function DatabaseChat() {
  const [prompt, setPrompt] = useState('');
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<any>(null);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      const res = await fetch('/api/chat-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt }),
      });

      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Request failed');

      setResponse(json);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ maxWidth: 800, margin: '2rem auto', fontFamily: 'sans-serif' }}>
      <h2>💬 Natural Language Database Query</h2>

      <form onSubmit={handleSubmit} style={{ display: 'flex', gap: '0.5rem' }}>
        <input
          type="text"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder="e.g. Find inactive subscribers and show their full name and last login"
          style={{ flex: 1, padding: '0.75rem', borderRadius: 6, border: '1px solid #ccc' }}
        />
        <button type="submit" disabled={loading} style={{ padding: '0.75rem 1.5rem', cursor: 'pointer' }}>
          {loading ? 'Querying...' : 'Ask DB'}
        </button>
      </form>

      {error && <p style={{ color: 'red', marginTop: '1rem' }}>❌ {error}</p>}

      {response && (
        <div style={{ marginTop: '1.5rem', background: '#f5f5f5', padding: '1.25rem', borderRadius: 8 }}>
          {/* Natural Language Response */}
          {response.naturalLanguage && (
            <div style={{ background: '#e8f4fd', borderLeft: '4px solid #0288d1', padding: '0.75rem 1rem', marginBottom: '1rem', borderRadius: 4 }}>
              <strong>🤖 AI Answer:</strong>
              <p style={{ margin: '0.25rem 0 0' }}>{response.naturalLanguage}</p>
            </div>
          )}

          <h4>Target Model: <code>{response.targetTable}</code> ({response.data.length} records)</h4>
          <pre style={{ maxHeight: 350, overflow: 'auto', background: '#fff', padding: '1rem', borderRadius: 4 }}>
            {JSON.stringify(response.data, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
```

---

## 🔗 Multi-Level Relational Queries

When users ask relational questions across connected tables, `prisma-safe-ai-query` constructs nested Prisma relations:

**Prompt:**
> *"Who are the inactive subscribers on the database and tell me their full names and their last login attempt?"*

**Generated Query Object:**
```javascript
{
  targetTable: 'subscription',
  where: {
    AND: [
      { status: { equals: 'inactive' } }
    ]
  },
  include: {
    user: {
      include: {
        loginAttempts: {
          take: 1,
          orderBy: { createdAt: 'desc' }
        }
      }
    }
  }
}
```

This output matches standard Prisma syntax directly:
```typescript
const result = await prisma[query.targetTable].findMany({
  where: query.where,
  include: query.include
});
```

---

## 🧬 Zero-Config Schema Introspection

Schema introspection is enabled by default. The agent looks for `./prisma/schema.prisma` and then `./schema.prisma`; you can provide a custom path or an initialized Prisma client:

```typescript
// 1. Automatic: Finds ./prisma/schema.prisma or ./schema.prisma
const query = await aiAgent.generateSafeQuery(prompt);

// 2. Custom schema location
const query = await aiAgent.generateSafeQuery(prompt, {
  schemaPath: './db/prisma/schema.prisma'
});

// 3. Or pass your initialized PrismaClient directly
const query = await aiAgent.generateSafeQuery(prompt, {
  prismaClient: prisma
});

// 4. Disable automatic schema discovery and provide your own context
const query = await aiAgent.generateSafeQuery(prompt, {
  autoIntrospect: false,
  dbContext: 'Model User { id: Int, email: String }'
});
```

### Privacy & Security Guarantee
The introspection utilities extract only model and field metadata for:
- Models & relation fields
- Scalar columns & types
- Enums & enum values

Datasource URLs and generator configuration are not included in the formatted context sent to Gemini. `parsePrismaSchemaText`, `extractPrismaSchema`, `formatSchemaForAIContext`, and `findPrismaSchemaPath` are also exported for applications that need to inspect or format schema metadata directly.

---

## 🔒 Security & Access Control

Control what tables, columns, and relations the AI is permitted to touch using recursive validation rules:

```typescript
const query = await aiAgent.generateSafeQuery(prompt, {
  // Option A: Block specific sensitive fields anywhere in the query
  blockList: [
    'passwordHash',      // Blocks any column named passwordHash
    'creditCardNumber',  // Blocks creditCardNumber
    'auditLogs',         // Blocks the auditLogs table
    'user.privateNotes'  // Blocks relational dot-paths
  ],

  // Option B: Allow only these target models and fields / relation paths
  // A model entry permits the target model; it does not by itself permit every field.
  // allowList: ['user', 'email', 'fullName']
});
```

Rules support exact names and dot-path descendants. For example, `user.email` permits that relation path, and `user` permits a target table named `user`. Add explicit field names when filtering by scalar columns. `blockList` takes precedence over `allowList`.

### Fail-Closed Behavior
If an AI attempt targets a blocked column (e.g. `include: { user: { select: { passwordHash: true } } }`), the engine throws a `Security Exception` immediately before execution.

---

## 🤖 Dynamic Gemini Model Selection

Switch Gemini models dynamically via environment variables or per agent instance:

```env
# In your .env file
GEMINI_MODEL=gemini-2.5-flash
```

Or pass it directly in code:

```typescript
// 1. Explicit model override in constructor
const agent = new PrismaGeminiAgent('api-key-here', 'gemini-1.5-pro');

// 2. Default fallback
const agent = new PrismaGeminiAgent(); // Uses GEMINI_MODEL env or gemini-3.1-flash-lite-preview
```

---

## 🛠️ Standalone Parser for Custom LLMs

If you use OpenAI, Anthropic Claude, or local Ollama models, you can still use the core sanitization engine independently:

```typescript
import { PrismaAIEngine } from 'prisma-safe-ai-query';

// Accepts raw LLM JSON string or parsed object
const query = PrismaAIEngine.parseDynamicQuery(rawAiResponse, {
  blockList: ['password', 'secretKey']
});

console.log(query.targetTable); // 'user'
console.log(query.where);       // { AND: [...] }
console.log(query.include);     // Nested relations
```

---

## 📖 API Reference

### `new PrismaGeminiAgent(apiKey?: string, model?: string)`
Creates a new AI agent instance.
- `apiKey`: Optional. Defaults to `process.env.GEMINI_API_KEY`.
- `model`: Optional. Defaults to `process.env.GEMINI_MODEL` or `"gemini-3.1-flash-lite-preview"`.

### `agent.generateSafeQuery(prompt: string, config?: AgentConfig)`
Generates and sanitizes a complete Prisma query.
- `config.blockList`: Array of string patterns to block.
- `config.allowList`: Array of allowed models and fields (strict mode).
- `config.schemaPath`: Path to `schema.prisma`.
- `config.prismaClient`: PrismaClient instance for introspection.
- `config.autoIntrospect`: Boolean (default: `true`).
- `config.dbContext`: Custom text to supplement database context.
- `config.schemaContext`: Optional extracted schema metadata used to coerce filter values to Prisma field types.
- `config.naturalLanguageResponse`: Controls `execute()` summaries; defaults to `NATURAL_LANGUAGE_RESPONSE`, then `true`.

### `agent.execute(prompt: string, prismaClient: PrismaClient, config?: AgentConfig)`
Generates a safe query, executes it through the matching Prisma model's `findMany`, and returns `{ data, query, naturalLanguage? }`. It can use an explicit `select` or `include`, sorting, and pagination from the generated query. If neither `select` nor `include` is provided, it may build a field selection from introspected model metadata when access rules are configured. When the prompt requests related data but no relation was included, it can also attempt to fetch related records through detected foreign-key fields. Blocked or non-allowlisted data is filtered from the returned records.

When `naturalLanguageResponse` is disabled, `naturalLanguage` is omitted and no summary generation call is made.

### Standalone schema utilities
The package also exports `extractPrismaSchema`, `parsePrismaSchemaText`, `formatSchemaForAIContext`, `findPrismaSchemaPath`, and the `ExtractedSchema`, `ExtractedModel`, `ExtractedField`, and `ExtractedEnum` types. `PrismaAIEngine.filterBlockedData(data, config?)` is available to recursively filter records with the same security configuration.

### Returns `ParsedDynamicQuery`:
```typescript
interface ParsedDynamicQuery {
  targetTable: string;
  where: Record<string, any>;
  include?: Record<string, any>;
  select?: Record<string, any>;
  orderBy?: any;
  take?: number;
  skip?: number;
}
```

---

## 📄 License

MIT © [Olugbenga Taiwo](https://github.com/gbengataiwo)
