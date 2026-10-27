# 🛡️ Prisma Safe AI Query

A lightweight, enterprise-grade utility that securely translates natural language into strongly typed, safe Prisma queries using Google Gemini. By bundling `@google/genai` and `zod` directly, this package eliminates all backend boilerplate. You pass in a user prompt, and the package handles the AI orchestration, schema enforcement, and SQL-injection prevention automatically.

## 📦 Installation

```bash
npm install prisma-safe-ai-query
```
*(Requires `@prisma/client` as a peer dependency)*

## 🚀 Quick Start (The PrismaGeminiAgent)

Instead of manually configuring the Gemini SDK, our built-in `PrismaGeminiAgent` handles everything end-to-end.

### 1. Set your API Key
Ensure you have your Gemini API key in your `.env` file:
```env
GEMINI_API_KEY=your_copied_api_key_here
GEMINI_MODEL=gemini_model_name_here
```
*(Need an API key? Get one for free at [aistudio.google.com](https://aistudio.google.com/))*

## 💬 The Chat Flow (Frontend to Backend)

This package makes it incredibly easy to build a "Chat with your Database" UI. Your frontend remains a simple chat interface, while `PrismaGeminiAgent` handles the heavy lifting on your backend.

### Step 1: The Frontend (React/Vue/Vanilla)
The user types a natural language query in your chat UI (e.g., *"Show me all active users in London"*). The frontend simply POSTs this message to your backend.

```javascript
// Example React submit handler
async function handleChatSubmit(userInput) {
  const response = await fetch('/api/chat', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ userPrompt: userInput })
  });

  const result = await response.json();

  if (result.error) return alert(result.error);

  console.log("Safe Database Results:", result.data);
  // Render results in your chat UI...
}
```

### Step 2: The Backend API Route (Next.js / Express)
Your backend receives the prompt, safely converts it to a Prisma query, executes it dynamically across ANY table, and returns the data.

**Import your Prisma Client**
```typescript
// Prisma v5 import
import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

// Prisma v6+ import from helper file
// const prisma = require("./helper/prisma");
```
*(Check out my tutorial on [how to install Prisma v7.8.0 in your Express/PostgreSQL project](https://charisintelligence.com.ng/prisma-v7-express-postgresql/))*

**Execute the AI Agent**
```typescript
import { PrismaGeminiAgent } from 'prisma-safe-ai-query';

// Automatically picks up GEMINI_API_KEY from process.env
const aiAgent = new PrismaGeminiAgent(); 

export async function POST(req: Request) {
  const { userPrompt } = await req.json(); // e.g. "Show me all active users in London"

  try {
    // 1. One line handles Gemini generation, dynamic routing, and Zod security!
    const { targetTable, where } = await aiAgent.generateSafeQuery(userPrompt, {
      dbContext: "Available tables are user, product, and order.", // Helps Gemini route correctly
      blockList: ['password', 'credit_card'] // Automatically blocks these columns
    });

    // 2. DYNAMIC ROUTING: Validate the table and execute
    if (!targetTable || !(targetTable in prisma)) {
      return new Response(JSON.stringify({ error: "Invalid table requested." }), { status: 400 });
    }

    // Executes equivalent of prisma.user.findMany(...)
    const dbResults = await (prisma as any)[targetTable].findMany({
      where: where,
      take: 10
    });

    // 3. Return the data to the frontend chat UI
    return new Response(JSON.stringify({ data: dbResults }), { status: 200 });

  } catch (error) {
    return new Response(JSON.stringify({ error: error.message }), { status: 400 });
  }
}
```

## 🔒 Security Configuration

You can strictly control what the AI can and cannot access by passing a configuration object as the second parameter to the `aiAgent.generateSafeQuery()` method.

**Where to configure this:** You should update these settings directly inside your backend controller or API route file (e.g., `app/api/chat/route.ts` in Next.js, or your Express endpoint function) exactly where you process the incoming chat request.

```typescript
const { targetTable, where } = await aiAgent.generateSafeQuery(userPrompt, {
  
  // OPTION 1: Describe your DB to Gemini so it doesn't hallucinate tables. 
  // A fast hack is to use an AI (like ChatGPT) to generate your dbContext by giving it your prisma schema.
  dbContext: "We have tables: user, product. User has fields: email, role, status.",

  // OPTION 2: Block specific sensitive fields across all tables
  blockList: ['passwordHash', 'billingDetails'],

  // OPTION 3: Strict Mode - allow ONLY these fields
  // allowList: ['status', 'role', 'city']
});
```

## 👨‍💻 Author
Created by **Olugbenga Taiwo**
- [LinkedIn](https://www.linkedin.com/in/taiwo-olugbenga)
- [GitHub Profile](https://github.com/oluibk2020/)