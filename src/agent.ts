import { GoogleGenAI, Type, Schema as GeminiSchema } from "@google/genai";
import { PrismaAIEngine, SecurityConfig } from "./engine";

const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";

export interface AgentConfig extends SecurityConfig {
  /** Describe your database tables/columns to help Gemini generate accurate queries (e.g. "Tables available: user, product") */
  dbContext?: string;
}

export class PrismaGeminiAgent {
  private ai: GoogleGenAI;
  private model: string;

  constructor(apiKey?: string, model?: string) {
    const key = apiKey || process.env.GEMINI_API_KEY;
    if (!key) {
      throw new Error(
        "FATAL ERROR: GEMINI_API_KEY is missing. Pass it to the constructor or set it in your .env file.",
      );
    }
    this.ai = new GoogleGenAI({ apiKey: key });
    this.model = model || process.env.GEMINI_MODEL || DEFAULT_MODEL;
  }

  /**
   * Translates a natural language prompt directly into a validated Prisma query.
   */
  async generateSafeQuery(userPrompt: string, config?: AgentConfig) {
    const GeminiQuerySchema: GeminiSchema = {
      type: Type.OBJECT,
      properties: {
        targetTable: {
          type: Type.STRING,
          description:
            "The dynamic database table to query (e.g., 'user', 'product')",
        },
        logicalOperator: { type: Type.STRING, enum: ["AND", "OR"] },
        filters: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              field: { type: Type.STRING },
              operator: {
                type: Type.STRING,
                enum: [
                  "equals",
                  "not",
                  "in",
                  "notIn",
                  "lt",
                  "lte",
                  "gt",
                  "gte",
                  "contains",
                  "startsWith",
                  "endsWith",
                ],
              },
              value: { type: Type.STRING },
            },
            required: ["field", "operator", "value"],
          },
        },
      },
      required: ["targetTable", "logicalOperator", "filters"],
    };

    const instruction = config?.dbContext
      ? `Convert the user request to database filters. Database Context: ${config.dbContext}`
      : `Convert the user request to database filters.`;

    const intentResponse = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: [{ text: userPrompt }] }],
      config: {
        systemInstruction: instruction,
        responseMimeType: "application/json",
        responseSchema: GeminiQuerySchema,
        temperature: 0.1,
      },
    });

    if (!intentResponse.text) {
      throw new Error("Gemini failed to generate a response.");
    }

    // Pass the Gemini JSON through our Zod engine to ensure Allowlist/Blocklist rules are enforced
    return PrismaAIEngine.parseDynamicQuery(intentResponse.text, config);
  }
}
