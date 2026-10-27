import { z } from 'zod';

export const PrismaOperatorSchema = z.enum([
  'equals', 'not', 'in', 'notIn', 'lt', 'lte', 
  'gt', 'gte', 'contains', 'startsWith', 'endsWith'
]);

export const QueryConditionSchema = z.object({
  field: z.string().describe("The database column name (can include dot notation for relations)"),
  operator: PrismaOperatorSchema,
  value: z.any().describe("The value to filter by"),
});

export const AIQueryResponseSchema = z.object({
  targetTable: z.string().optional().describe("The dynamic database table to query (e.g., 'user', 'product')"),
  logicalOperator: z.enum(['AND', 'OR']).default('AND'),
  filters: z.array(QueryConditionSchema)
});

export type AIQueryResponse = z.infer<typeof AIQueryResponseSchema>;
