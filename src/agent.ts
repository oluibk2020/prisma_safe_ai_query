import { GoogleGenAI, Type, Schema as GeminiSchema } from "@google/genai";
import { PrismaAIEngine, SecurityConfig, ParsedDynamicQuery } from "./engine";
import {
  extractPrismaSchema,
  formatSchemaForAIContext,
  ExtractedSchema,
} from "./introspect";

const DEFAULT_MODEL = "gemini-3.1-flash-lite-preview";

export interface AgentConfig extends SecurityConfig {
  /**
   * Describe your database tables/columns to help Gemini generate accurate queries.
   * If omitted and schemaPath or autoIntrospect is enabled, schema information will be extracted automatically.
   */
  dbContext?: string;

  /**
   * Optional path to the schema.prisma file (e.g. "./prisma/schema.prisma").
   * If omitted, it automatically scans standard locations.
   */
  schemaPath?: string;

  /**
   * Optional PrismaClient or DMMF object to introspect models/relations from.
   */
  prismaClient?: any;

  /**
   * Automatically introspect models, relations, fields, and enums from schema.prisma or prismaClient.
   * Defaults to true.
   */
  autoIntrospect?: boolean;

  /**
   * Whether to generate a human-friendly natural language response summarizing the query results.
   * Defaults to process.env.NATURAL_LANGUAGE_RESPONSE ?? true.
   */
  naturalLanguageResponse?: boolean;
}

export interface NaturalLanguageResult<T = any> {
  /**
   * Structured records returned from the database execution.
   */
  data: T;

  /**
   * Conversational natural language summary answering the user's initial question.
   * Only generated if naturalLanguageResponse is true.
   */
  naturalLanguage?: string;

  /**
   * The sanitized Prisma query details used to fetch the data.
   */
  query: ParsedDynamicQuery;
}

export class PrismaGeminiAgent {
  private ai: GoogleGenAI;
  private model: string;
  private cachedContext?: string;
  private cachedSchema?: ExtractedSchema;

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
   * Resolves the database context by combining explicit dbContext with automatically introspected schema.
   */
  private resolveDbContext(config?: AgentConfig): string {
    const contextParts: string[] = [];

    if (config?.dbContext) {
      contextParts.push(config.dbContext);
    }

    const autoIntrospect = config?.autoIntrospect ?? true;
    if (autoIntrospect) {
      if (!this.cachedContext || config?.prismaClient || config?.schemaPath) {
        const schemaSource = config?.prismaClient || config?.schemaPath;
        const extracted = extractPrismaSchema(schemaSource);
        if (extracted.models.length > 0 || extracted.enums.length > 0) {
          this.cachedSchema = extracted;
          this.cachedContext = formatSchemaForAIContext(extracted);
        }
      }
      if (this.cachedContext) {
        contextParts.push(this.cachedContext);
      }
    }

    return contextParts.join("\n\n");
  }

  /**
   * Determines whether natural language response generation is enabled.
   */
  public isNaturalLanguageEnabled(config?: AgentConfig): boolean {
    if (typeof config?.naturalLanguageResponse === "boolean") {
      return config.naturalLanguageResponse;
    }
    if (process.env.NATURAL_LANGUAGE_RESPONSE !== undefined) {
      const val = process.env.NATURAL_LANGUAGE_RESPONSE.trim().toLowerCase();
      return val === "true" || val === "1";
    }
    return true;
  }

  /**
   * Translates a natural language prompt directly into a validated multi-level Prisma query.
   */
  async generateSafeQuery(
    userPrompt: string,
    config?: AgentConfig,
  ): Promise<ParsedDynamicQuery> {
    const GeminiQuerySchema: GeminiSchema = {
      type: Type.OBJECT,
      properties: {
        targetTable: {
          type: Type.STRING,
          description:
            "The primary database model to query in camelCase (e.g., 'subscription', 'user')",
        },
        logicalOperator: {
          type: Type.STRING,
          enum: ["AND", "OR"],
        },
        filters: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              field: {
                type: Type.STRING,
                description:
                  "Field name or relational dot-path (e.g., 'status', 'user.email')",
              },
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
                  "some",
                  "every",
                  "none",
                  "is",
                  "isNot",
                ],
              },
              value: {
                type: Type.STRING,
                description:
                  "Filter value as string, number, boolean, or JSON array",
              },
            },
            required: ["field", "operator", "value"],
          },
        },
        include: {
          type: Type.STRING,
          nullable: true,
          description:
            'JSON string representing nested Prisma relations to include across multiple levels. Example: \'{"user":{"include":{"loginAttempts":{"take":1,"orderBy":{"createdAt":"desc"}}}}}\'. Do NOT use both include and select at the root level.',
        },
        select: {
          type: Type.STRING,
          nullable: true,
          description:
            "JSON string for selecting specific fields. Leave null if using include.",
        },
        orderBy: {
          type: Type.STRING,
          nullable: true,
          description: 'JSON string for sorting, e.g. \'{"createdAt":"desc"}\'',
        },
        take: {
          type: Type.INTEGER,
          nullable: true,
          description:
            "Limit number of records returned. Must be a positive integer (e.g. 10). Omit or set null if not needed.",
        },
        skip: {
          type: Type.INTEGER,
          nullable: true,
          description: "Pagination offset. Non-negative integer.",
        },
      },
      required: ["targetTable", "logicalOperator", "filters"],
    };

    const resolvedContext = this.resolveDbContext(config);

    const baseRules = `You are an expert Prisma ORM multi-level query planner. Translate the user's natural language prompt into a valid Prisma findMany query object.

MULTI-LEVEL RELATIONAL QUERY RULES:
1. Identify the primary table to query as 'targetTable' in camelCase (e.g. "subscription").
2. When the user asks for information located in linked/related tables (for example: asking for inactive subscribers in 'subscription', their full name in 'user', and their last login attempt in 'loginAttempts'), you MUST traverse the relations using a nested 'include' JSON object.
3. For "last", "latest", or "most recent" child records on a 1-to-many relation (e.g. loginAttempts), nest '{"take": 1, "orderBy": {"createdAt": "desc"}}' inside that relation's include block.
   Example for "inactive subscribers, their full names, and their last login attempt":
   - targetTable: "subscription"
   - filters: [{ "field": "status", "operator": "equals", "value": "INACTIVE" }]
   - include: '{"user":{"include":{"loginAttempts":{"take":1,"orderBy":{"createdAt":"desc"}}}}}'
4. Never specify both 'include' and 'select' at the same level. Prefer 'include' when joining related tables.
5. Match enum values to the exact casing shown in the schema if an Enum is defined.`;

    const instruction = resolvedContext
      ? `${baseRules}\n\nDatabase Context & Models:\n${resolvedContext}`
      : baseRules;

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

    const finalConfig: AgentConfig = {
      ...config,
      schemaContext: config?.schemaContext || this.cachedSchema,
    };

    return PrismaAIEngine.parseDynamicQuery(intentResponse.text, finalConfig);
  }

  /**
   * Summarizes the raw database records into a conversational, natural language answer.
   */
  async formatAnswer(
    userPrompt: string,
    databaseResults: any,
  ): Promise<string> {
    const prompt = `You are a helpful database assistant.
The user asked: "${userPrompt}"

The database returned the following records:
${JSON.stringify(databaseResults, null, 2)}

Provide a clear, natural language answer directly addressing the user's question in a professional, conversational tone. Be concise and accurate based strictly on the returned data. If no records were found, explain that politely.`;

    const response = await this.ai.models.generateContent({
      model: this.model,
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      config: {
        temperature: 0.2,
      },
    });

    return response.text?.trim() || "";
  }

  /**
   * Resolves the exact delegate key on the PrismaClient instance (handles PascalCase vs camelCase).
   */
  private resolveClientDelegateKey(
    targetTable: string,
    prismaClient: any,
  ): string | null {
    if (!prismaClient || typeof prismaClient !== "object") return null;
    if (targetTable in prismaClient) return targetTable;

    const camel = targetTable.charAt(0).toLowerCase() + targetTable.slice(1);
    if (camel in prismaClient) return camel;

    const lower = targetTable.toLowerCase();
    for (const key of Object.keys(prismaClient)) {
      if (key.toLowerCase() === lower || key.toLowerCase() === `${lower}s`) {
        return key;
      }
    }
    return null;
  }

  /**
   * Fallback multi-level foreign-key stitcher:
   * If returned rows contain foreign key columns (e.g. `userId`) and the prompt mentions related entities
   * that weren't already populated via Prisma `include`, automatically fetches the linked rows (and their 2nd-level children).
   */
  private async stitchLinkedRelations(
    rows: any[],
    userPrompt: string,
    prismaClient: any,
    rootTable: string,
    config?: AgentConfig,
  ): Promise<any[]> {
    if (!Array.isArray(rows) || rows.length === 0 || !prismaClient) {
      return rows;
    }

    const promptLower = userPrompt.toLowerCase();
    const firstRow = rows[0];
    if (!firstRow || typeof firstRow !== "object") return rows;

    // Detect foreign keys like `userId`, `customerId`, `accountId`
    const fkColumns = Object.keys(firstRow).filter(
      (k) => k.endsWith("Id") && k.length > 2,
    );

    for (const fkCol of fkColumns) {
      const relationName = fkCol.slice(0, -2); // e.g., 'userId' -> 'user'
      // Skip if already included by Prisma
      if (firstRow[relationName] !== undefined) continue;

      const delegateKey = this.resolveClientDelegateKey(
        relationName,
        prismaClient,
      );
      if (
        !delegateKey ||
        typeof prismaClient[delegateKey]?.findMany !== "function"
      )
        continue;

      // Check if this table is blocked
      try {
        PrismaAIEngine["validatePath"](delegateKey, config, "table");
      } catch {
        continue;
      }

      const fkIds = Array.from(
        new Set(
          rows
            .map((r) => r[fkCol])
            .filter((v) => v !== null && v !== undefined),
        ),
      );
      if (fkIds.length === 0) continue;

      const parentRecords = await prismaClient[delegateKey].findMany({
        where: { id: { in: fkIds } },
      });

      // Check if prompt asks for a 2nd-level child table linked by the same foreign key (e.g. loginAttempts via userId)
      for (const clientKey of Object.keys(prismaClient)) {
        if (
          clientKey.startsWith("_") ||
          clientKey.startsWith("$") ||
          clientKey === delegateKey ||
          clientKey.toLowerCase() === rootTable.toLowerCase()
        ) {
          continue;
        }
        if (typeof prismaClient[clientKey]?.findMany !== "function") continue;

        // Match if prompt mentions this child table (e.g. "login attempt" -> "loginAttempt" / "loginAttempts")
        const readableKey = clientKey
          .replace(/([A-Z])/g, " $1")
          .toLowerCase()
          .trim();
        const singularReadable = readableKey.endsWith("s")
          ? readableKey.slice(0, -1)
          : readableKey;

        if (
          promptLower.includes(readableKey) ||
          promptLower.includes(singularReadable)
        ) {
          try {
            PrismaAIEngine["validatePath"](clientKey, config, "table");
            const childRecords = await prismaClient[clientKey].findMany({
              where: { [fkCol]: { in: fkIds } },
              orderBy: { createdAt: "desc" },
            });

            const wantsLastOnly = /\b(last|latest|most recent)\b/i.test(
              userPrompt,
            );
            const childrenByFk = new Map<any, any[]>();
            for (const child of childRecords) {
              const keyVal = child[fkCol];
              if (!childrenByFk.has(keyVal)) childrenByFk.set(keyVal, []);
              const list = childrenByFk.get(keyVal)!;
              if (!wantsLastOnly || list.length < 1) {
                list.push(child);
              }
            }

            const pluralField = clientKey.endsWith("s")
              ? clientKey
              : `${clientKey}s`;
            for (const parent of parentRecords) {
              parent[pluralField] = childrenByFk.get(parent.id) || [];
            }
          } catch {
            // Ignore if child table doesn't have fkCol or createdAt
          }
        }
      }

      const parentById = new Map(parentRecords.map((p: any) => [p.id, p]));
      for (const row of rows) {
        row[relationName] = parentById.get(row[fkCol]) || null;
      }
    }

    return rows;
  }

  /**
   * End-to-end execution helper:
   * 1. Introspects schema from prismaClient/schema.prisma and generates the safe multi-level Prisma query
   * 2. Executes it on the provided prisma client (and auto-stitches foreign keys if needed)
   * 3. Recursively strips any blocked fields
   * 4. Optionally generates a natural language summary if enabled (defaults to true)
   */
  async execute<T = any>(
    userPrompt: string,
    prismaClient: any,
    config?: AgentConfig,
  ): Promise<NaturalLanguageResult<T>> {
    const mergedConfig: AgentConfig = {
      ...config,
      prismaClient: config?.prismaClient || prismaClient,
    };

    const query = await this.generateSafeQuery(userPrompt, mergedConfig);
    const delegateKey = this.resolveClientDelegateKey(
      query.targetTable,
      prismaClient,
    );

    if (
      !delegateKey ||
      typeof prismaClient[delegateKey]?.findMany !== "function"
    ) {
      throw new Error(
        `Invalid or unauthorized table target: ${query.targetTable}`,
      );
    }

    // Normalize targetTable to the actual client delegate key
    query.targetTable = delegateKey;

    const findArgs: Record<string, any> = {
      where: query.where,
    };

    if (query.select && Object.keys(query.select).length > 0) {
      findArgs.select = query.select;
    } else if (query.include && Object.keys(query.include).length > 0) {
      findArgs.include = query.include;
    }

    if (query.orderBy) findArgs.orderBy = query.orderBy;
    if (typeof query.take === "number") findArgs.take = query.take;
    if (typeof query.skip === "number") findArgs.skip = query.skip;

    // 1. Build an automatic select clause if neither select nor include was provided by the AI,
    // explicitly omitting all blocked fields from the database query itself
    if (!findArgs.select && !findArgs.include) {
      const lowerTarget = query.targetTable.toLowerCase();
      const model = this.cachedSchema?.models.find(
        (m) => m.name.toLowerCase() === lowerTarget,
      );
      if (
        model &&
        (mergedConfig?.blockList?.length || mergedConfig?.allowList?.length)
      ) {
        const autoSelect: Record<string, boolean> = {};
        for (const field of model.fields) {
          if (field.relation) continue;

          let isBlocked = false;
          if (mergedConfig.blockList?.length) {
            isBlocked = mergedConfig.blockList.some((b) => {
              const rule = b.trim();
              return (
                field.name === rule ||
                field.name.toLowerCase() === rule.toLowerCase() ||
                rule.toLowerCase() ===
                  `${lowerTarget}.${field.name.toLowerCase()}`
              );
            });
          }

          let isAllowed = true;
          if (mergedConfig.allowList?.length) {
            isAllowed = mergedConfig.allowList.some((a) => {
              const rule = a.trim();
              return (
                field.name === rule ||
                rule.toLowerCase() ===
                  `${lowerTarget}.${field.name.toLowerCase()}` ||
                rule.toLowerCase() === lowerTarget
              );
            });
          }

          if (!isBlocked && isAllowed) {
            autoSelect[field.name] = true;
          }
        }

        if (Object.keys(autoSelect).length > 0) {
          findArgs.select = autoSelect;
        }
      }
    }

    let rawData = await prismaClient[delegateKey].findMany(findArgs);

    // 2. If the query did not include nested relations but returned foreign key IDs (like userId),
    // automatically stitch linked tables when requested by the prompt
    if (!findArgs.include && Array.isArray(rawData) && rawData.length > 0) {
      rawData = await this.stitchLinkedRelations(
        rawData,
        userPrompt,
        prismaClient,
        delegateKey,
        mergedConfig,
      );
    }

    // 3. Post-execution deep scrub: recursively strip any blocked fields from the returned data
    const data = PrismaAIEngine.filterBlockedData(
      rawData,
      mergedConfig,
      "",
      delegateKey,
    );

    const isNL = this.isNaturalLanguageEnabled(mergedConfig);
    if (!isNL) {
      return {
        data,
        query,
      };
    }

    const naturalLanguage = await this.formatAnswer(userPrompt, data);

    return {
      data,
      naturalLanguage,
      query,
    };
  }
}
