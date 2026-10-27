import { AIQueryResponseSchema } from './schema';

export interface SecurityConfig {
  /** Explicitly allow only these fields. If provided, everything else is blocked. */
  allowList?: string[];
  /** Explicitly block these fields or tables (supports exact match or dot-notation prefixes like 'user.password'). */
  blockList?: string[];
}

export class PrismaAIEngine {
  private static matchesSecurityRule(value: string, rule: string): boolean {
    const normalizedValue = value.trim();
    const normalizedRule = rule.trim();

    if (!normalizedValue || !normalizedRule) {
      return false;
    }

    return normalizedValue === normalizedRule || normalizedValue.startsWith(`${normalizedRule}.`);
  }

  private static normalizeFilterValue(filter: { field: string; operator: string; value?: unknown }): unknown {
    const { operator, value } = filter;

    if (operator === 'in' || operator === 'notIn') {
      if (Array.isArray(value)) {
        return value;
      }

      if (typeof value === 'string') {
        const trimmed = value.trim();

        if (!trimmed) {
          return [];
        }

        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed);
            return Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            // Fall back to comma-splitting below.
          }
        }

        return trimmed.includes(',')
          ? trimmed.split(',').map(part => part.trim()).filter(Boolean)
          : [trimmed];
      }

      return [value];
    }

    if (typeof value === 'string') {
      const trimmed = value.trim();

      if (!trimmed) {
        return value;
      }

      try {
        if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
          const parsed = JSON.parse(trimmed);
          return parsed;
        }
      } catch {
        // Keep the original string when the value is not valid JSON.
      }
    }

    return value;
  }

  static parseDynamicQuery(rawAiOutput: unknown, config?: SecurityConfig): { targetTable?: string, where: any } {
    let parsedInput: unknown = rawAiOutput;
    
    if (typeof rawAiOutput === 'string') {
        try {
            parsedInput = JSON.parse(rawAiOutput);
        } catch (e) {
            throw new Error("AI output was not valid JSON.");
        }
    }

    const validatedData = AIQueryResponseSchema.parse(parsedInput);

    const targetTable = typeof validatedData.targetTable === 'string' ? validatedData.targetTable.trim() : '';

    if (!targetTable) {
      throw new Error('Security Exception: AI output did not include a valid targetTable.');
    }

    if (config?.blockList && config.blockList.some(rule => this.matchesSecurityRule(targetTable, rule))) {
      throw new Error(`Security Exception: AI attempted to query a blocked table -> ${targetTable}`);
    }

    if (config?.allowList && !config.allowList.some(rule => this.matchesSecurityRule(targetTable, rule))) {
      throw new Error(`Security Exception: AI attempted to query a non-allowlisted table -> ${targetTable}`);
    }

    const conditions = validatedData.filters.map(filter => {
      const normalizedField = filter.field.trim();

      if (config?.blockList && config.blockList.some(rule => this.matchesSecurityRule(normalizedField, rule))) {
        throw new Error(`Security Exception: AI attempted to query a blocked table or field -> ${normalizedField}`);
      }

      if (config?.allowList && !config.allowList.some(rule => this.matchesSecurityRule(normalizedField, rule))) {
        throw new Error(`Security Exception: AI attempted to query a non-allowlisted field -> ${normalizedField}`);
      }

      const normalizedValue = this.normalizeFilterValue(filter);

      return {
        [normalizedField]: {
          [filter.operator]: normalizedValue
        }
      };
    });

    const whereClause = conditions.length === 0 ? {} : { [validatedData.logicalOperator]: conditions };

    return {
        targetTable,
        where: whereClause
    };
  }
}
