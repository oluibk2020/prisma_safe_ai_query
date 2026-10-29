import { z } from "zod";

export const PrismaOperatorSchema = z.enum([
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
  // Relational list operators
  "some",
  "every",
  "none",
  // Nullability & existence operators
  "is",
  "isNot",
]);

export interface QueryCondition {
  field: string;
  operator: z.infer<typeof PrismaOperatorSchema>;
  value?: any;
}

export const QueryConditionSchema: z.ZodType<QueryCondition> = z.lazy(() =>
  z.object({
    field: z
      .string()
      .describe(
        "The database column name or relation field (supports dot-notation like 'user.email')",
      ),
    operator: PrismaOperatorSchema,
    value: z
      .any()
      .optional()
      .describe("The filter value or nested sub-condition"),
  }),
);

export const OrderByDirectionSchema = z.enum(["asc", "desc"]);
export const OrderByItemSchema = z.record(z.string(), OrderByDirectionSchema);

const parseJsonOrObject = (val: unknown) => {
  if (val === null || val === undefined || val === "") return undefined;
  if (typeof val === "string") {
    const trimmed = val.trim();
    if (!trimmed) return undefined;
    try {
      return JSON.parse(trimmed);
    } catch {
      return undefined;
    }
  }
  return val;
};

export const AIQueryResponseSchema = z.object({
  targetTable: z
    .string()
    .optional()
    .describe(
      "The primary database table to query (e.g., 'subscription', 'user')",
    ),
  logicalOperator: z.enum(["AND", "OR"]).default("AND"),
  filters: z
    .array(QueryConditionSchema)
    .describe("Filter conditions for where clause"),
  include: z
    .preprocess(parseJsonOrObject, z.record(z.string(), z.any()).optional())
    .describe(
      "Relations to include in multi-level queries (nested object structure)",
    ),
  select: z
    .preprocess(parseJsonOrObject, z.record(z.string(), z.any()).optional())
    .describe("Specific fields to select"),
  orderBy: z
    .preprocess(
      parseJsonOrObject,
      z
        .union([
          OrderByItemSchema,
          z.array(OrderByItemSchema),
          z.record(z.string(), z.any()),
        ])
        .optional(),
    )
    .describe("Ordering of the results"),
  take: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const parsed = typeof val === "string" ? parseInt(val, 10) : val;
      if (isNaN(parsed) || parsed <= 0) return undefined;
      return parsed;
    })
    .describe("Maximum number of rows to return (positive integer)"),
  skip: z
    .union([z.number(), z.string(), z.null()])
    .optional()
    .transform((val) => {
      if (val === null || val === undefined || val === "") return undefined;
      const parsed = typeof val === "string" ? parseInt(val, 10) : val;
      if (isNaN(parsed) || parsed < 0) return undefined;
      return parsed;
    })
    .describe("Number of rows to skip (pagination)"),
});

export type AIQueryResponse = z.infer<typeof AIQueryResponseSchema>;
