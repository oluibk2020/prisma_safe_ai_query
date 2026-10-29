import { AIQueryResponseSchema } from "./schema";
import { ExtractedSchema, ExtractedModel } from "./introspect";

export interface SecurityConfig {
  /** Explicitly allow only these fields or relation paths. If provided, anything outside is blocked. */
  allowList?: string[];
  /** Explicitly block these fields, relations, or tables (supports exact match or dot-notation prefixes like 'user.password'). */
  blockList?: string[];
  /** Optional extracted schema used to strongly cast filter values to their actual Prisma column types (Int, Float, Boolean, Enum, etc.) */
  schemaContext?: ExtractedSchema;
}

export interface ParsedDynamicQuery {
  targetTable: string;
  where: Record<string, any>;
  include?: Record<string, any>;
  select?: Record<string, any>;
  orderBy?: any;
  take?: number;
  skip?: number;
}

const NUMERIC_FIELD_HEURISTIC =
  /(?:^id$|Id$|^age$|^count$|^total$|^amount$|^price$|^quantity$|^score$|^level$|^page$|^limit$)/;

export class PrismaAIEngine {
  private static matchesSecurityRule(value: string, rule: string): boolean {
    const normalizedValue = value.trim();
    const normalizedRule = rule.trim();
    if (!normalizedValue || !normalizedRule) {
      return false;
    }
    return (
      normalizedValue === normalizedRule ||
      normalizedValue.startsWith(`${normalizedRule}.`)
    );
  }

  private static validatePath(
    pathStr: string,
    config?: SecurityConfig,
    entityType: "table" | "field" | "relation" = "field",
    rootTable?: string,
  ): void {
    const normalizedPath = pathStr.trim();
    if (!normalizedPath) return;

    const parts = normalizedPath.split(".");
    const fieldLeaf = parts[parts.length - 1];
    const tablePrefixedPath =
      rootTable &&
      !normalizedPath.startsWith(`${rootTable}.`) &&
      normalizedPath !== rootTable
        ? `${rootTable}.${normalizedPath}`
        : normalizedPath;

    if (config?.blockList) {
      const isBlocked = config.blockList.some((rule) => {
        const trimmedRule = rule.trim();
        return (
          this.matchesSecurityRule(normalizedPath, trimmedRule) ||
          this.matchesSecurityRule(tablePrefixedPath, trimmedRule) ||
          this.matchesSecurityRule(fieldLeaf, trimmedRule)
        );
      });
      if (isBlocked) {
        if (entityType === "table") {
          throw new Error(
            `Security Exception: AI attempted to query a blocked table -> ${normalizedPath}`,
          );
        }
        throw new Error(
          `Security Exception: AI attempted to query a blocked table or field -> ${normalizedPath}`,
        );
      }
    }

    if (config?.allowList) {
      if (entityType === "table") {
        const isTableAllowed = config.allowList.some((rule) => {
          const trimmedRule = rule.trim();
          return (
            this.matchesSecurityRule(normalizedPath, trimmedRule) ||
            normalizedPath.toLowerCase() === trimmedRule.toLowerCase()
          );
        });
        if (!isTableAllowed) {
          throw new Error(
            `Security Exception: AI attempted to query a non-allowlisted table -> ${normalizedPath}`,
          );
        }
      } else {
        // For fields, check if the specific field path, prefixed path, or leaf is allowlisted
        const isFieldAllowed = config.allowList.some((rule) => {
          const trimmedRule = rule.trim();
          return (
            this.matchesSecurityRule(normalizedPath, trimmedRule) ||
            this.matchesSecurityRule(fieldLeaf, trimmedRule)
          );
        });
        if (!isFieldAllowed) {
          throw new Error(
            `Security Exception: AI attempted to query a non-allowlisted field -> ${normalizedPath}`,
          );
        }
      }
    }
  }

  private static coerceScalarValue(
    val: unknown,
    expectedType?: string,
    schema?: ExtractedSchema,
    fieldName?: string,
  ): unknown {
    if (val === null || val === undefined) return val;

    if (expectedType) {
      const lowerType = expectedType.toLowerCase();
      if (lowerType === "int" || lowerType === "bigint") {
        if (typeof val === "string") {
          const parsed = parseInt(val.trim(), 10);
          if (!isNaN(parsed)) return parsed;
        } else if (typeof val === "number") {
          return Math.round(val);
        }
      } else if (lowerType === "float" || lowerType === "decimal") {
        if (typeof val === "string") {
          const parsed = parseFloat(val.trim());
          if (!isNaN(parsed)) return parsed;
        }
      } else if (lowerType === "boolean") {
        if (typeof val === "string") {
          const trimmed = val.trim().toLowerCase();
          if (trimmed === "true") return true;
          if (trimmed === "false") return false;
        }
      } else if (lowerType === "datetime") {
        if (typeof val === "string" && val.trim()) {
          const d = new Date(val.trim());
          if (!isNaN(d.getTime())) return d;
        }
      } else if (schema?.enums?.length && typeof val === "string") {
        // Case-insensitive Enum matching (e.g. "inactive" -> "INACTIVE")
        const enumDef = schema.enums.find(
          (e) => e.name.toLowerCase() === lowerType,
        );
        if (enumDef) {
          const trimmedVal = val.trim();
          const matchedEnumVal = enumDef.values.find(
            (v) => v.toLowerCase() === trimmedVal.toLowerCase(),
          );
          if (matchedEnumVal) {
            return matchedEnumVal;
          }
        }
      }
    } else {
      // Heuristic fallback when schema type is not provided:
      // Only coerce numeric strings for likely numeric column names (id, userId, age, count, etc.)
      if (typeof val === "string") {
        const trimmed = val.trim();
        const leafName = fieldName ? fieldName.split(".").pop() || "" : "";
        if (
          /^-?\d+$/.test(trimmed) &&
          (!leafName || NUMERIC_FIELD_HEURISTIC.test(leafName))
        ) {
          const parsed = parseInt(trimmed, 10);
          if (Number.isSafeInteger(parsed)) return parsed;
        } else if (trimmed.toLowerCase() === "true") {
          return true;
        } else if (trimmed.toLowerCase() === "false") {
          return false;
        }
      }
    }

    return val;
  }

  private static normalizeFilterValue(
    filter: { field: string; operator: string; value?: unknown },
    expectedType?: string,
    schema?: ExtractedSchema,
  ): unknown {
    const { field, operator, value } = filter;

    if (operator === "in" || operator === "notIn") {
      let rawList: unknown[] = [];
      if (Array.isArray(value)) {
        rawList = value;
      } else if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) {
          return [];
        }
        if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
          try {
            const parsed = JSON.parse(trimmed);
            rawList = Array.isArray(parsed) ? parsed : [parsed];
          } catch {
            rawList = trimmed.includes(",")
              ? trimmed
                  .split(",")
                  .map((part) => part.trim())
                  .filter(Boolean)
              : [trimmed];
          }
        } else {
          rawList = trimmed.includes(",")
            ? trimmed
                .split(",")
                .map((part) => part.trim())
                .filter(Boolean)
            : [trimmed];
        }
      } else {
        rawList = [value];
      }

      return rawList.map((item) =>
        this.coerceScalarValue(item, expectedType, schema, field),
      );
    }

    if (typeof value === "string") {
      const trimmed = value.trim();
      if (!trimmed) {
        return value;
      }
      try {
        if (
          (trimmed.startsWith("[") && trimmed.endsWith("]")) ||
          (trimmed.startsWith("{") && trimmed.endsWith("}"))
        ) {
          const parsed = JSON.parse(trimmed);
          return parsed;
        }
      } catch {
        // Keep original string if not valid JSON
      }
    }

    return this.coerceScalarValue(value, expectedType, schema, field);
  }

  /**
   * Recursively strips blocked fields from returned database records or objects.
   */
  public static filterBlockedData<T = any>(
    data: T,
    config?: SecurityConfig,
    currentPath: string = "",
    rootTable?: string,
  ): T {
    if (!config?.blockList?.length && !config?.allowList?.length) {
      return data;
    }
    if (data === null || data === undefined) {
      return data;
    }
    if (Array.isArray(data)) {
      return data.map((item) =>
        this.filterBlockedData(item, config, currentPath, rootTable),
      ) as any;
    }
    if (typeof data === "object" && !(data instanceof Date)) {
      const sanitized: Record<string, any> = {};
      for (const [key, val] of Object.entries(data)) {
        const subPath = currentPath ? `${currentPath}.${key}` : key;
        const tablePrefixedPath =
          rootTable && !subPath.startsWith(`${rootTable}.`)
            ? `${rootTable}.${subPath}`
            : subPath;
        const parts = subPath.split(".");
        const fieldLeaf = parts[parts.length - 1];

        // Check blockList
        let isBlocked = false;
        if (config.blockList?.length) {
          isBlocked = config.blockList.some((rule) => {
            const trimmedRule = rule.trim();
            return (
              this.matchesSecurityRule(subPath, trimmedRule) ||
              this.matchesSecurityRule(fieldLeaf, trimmedRule)
            );
          });
        }

        // Check allowList (if supplied)
        let isAllowed = true;
        if (config.allowList?.length) {
          isAllowed = config.allowList.some((rule) => {
            const trimmedRule = rule.trim();
            return (
              this.matchesSecurityRule(subPath, trimmedRule) ||
              this.matchesSecurityRule(tablePrefixedPath, trimmedRule) ||
              this.matchesSecurityRule(fieldLeaf, trimmedRule)
            );
          });
        }

        if (isBlocked || !isAllowed) {
          continue;
        }

        sanitized[key] = this.filterBlockedData(
          val,
          config,
          subPath,
          rootTable,
        );
      }
      return sanitized as T;
    }
    return data;
  }

  private static sanitizeTree(
    tree: Record<string, any>,
    currentPath: string,
    config?: SecurityConfig,
    rootTable?: string,
  ): Record<string, any> {
    const sanitized: Record<string, any> = {};

    for (const [key, val] of Object.entries(tree)) {
      const isPrismaKeyword =
        key === "include" ||
        key === "select" ||
        key === "where" ||
        key === "orderBy" ||
        key === "take" ||
        key === "skip" ||
        key === "some" ||
        key === "every" ||
        key === "none" ||
        key === "is" ||
        key === "isNot";

      const subPath = isPrismaKeyword
        ? currentPath
        : currentPath
          ? `${currentPath}.${key}`
          : key;

      if (!isPrismaKeyword) {
        this.validatePath(subPath, config, "field", rootTable);
      }

      if (val === true || val === false) {
        sanitized[key] = val;
      } else if (val && typeof val === "object") {
        if (Array.isArray(val)) {
          sanitized[key] = val.map((item) =>
            item && typeof item === "object"
              ? this.sanitizeTree(item, subPath, config, rootTable)
              : item,
          );
        } else {
          sanitized[key] = this.sanitizeTree(val, subPath, config, rootTable);
        }
      } else {
        sanitized[key] = val;
      }
    }

    return sanitized;
  }

  private static sanitizeOrderBy(
    orderBy: any,
    config?: SecurityConfig,
    rootTable?: string,
  ): any {
    if (!orderBy) return undefined;
    if (Array.isArray(orderBy)) {
      return orderBy.map((item) =>
        this.sanitizeOrderBy(item, config, rootTable),
      );
    }
    if (typeof orderBy === "object") {
      return this.sanitizeTree(orderBy, "", config, rootTable);
    }
    return orderBy;
  }

  private static findModel(
    modelName: string,
    schema?: ExtractedSchema,
  ): ExtractedModel | undefined {
    if (!schema?.models?.length) return undefined;
    const lower = modelName.trim().toLowerCase();
    return schema.models.find((m) => m.name.toLowerCase() === lower);
  }

  /**
   * Expands dot-notation field paths (e.g. "user.profile.age" or "user.loginAttempts.success")
   * into nested Prisma filter objects, automatically wrapping list relations with `some`.
   */
  private static buildNestedCondition(
    fieldParts: string[],
    operator: string,
    value: unknown,
    currentModelName?: string,
    schema?: ExtractedSchema,
  ): Record<string, any> {
    if (fieldParts.length === 1) {
      return {
        [fieldParts[0]]: {
          [operator]: value,
        },
      };
    }

    const [head, ...tail] = fieldParts;
    const model = currentModelName
      ? this.findModel(currentModelName, schema)
      : undefined;
    const fieldDef = model?.fields.find(
      (f) => f.name.toLowerCase() === head.toLowerCase(),
    );
    const nextModelName = fieldDef?.type;

    const nestedInner = this.buildNestedCondition(
      tail,
      operator,
      value,
      nextModelName,
      schema,
    );

    // If the relation is a 1-to-many list (e.g. loginAttempts: LoginAttempt[]), Prisma requires `{ some: ... }`
    if (fieldDef?.isList && fieldDef?.relation) {
      return {
        [head]: {
          some: nestedInner,
        },
      };
    }

    return {
      [head]: nestedInner,
    };
  }

  /**
   * Resolves a field's type across both direct columns and multi-level dot-notation paths.
   */
  private static lookupFieldType(
    targetTable: string,
    fieldPath: string,
    schema?: ExtractedSchema,
  ): string | undefined {
    if (!schema?.models?.length) return undefined;
    const parts = fieldPath.trim().split(".");
    let currentModel = this.findModel(targetTable, schema);

    for (let i = 0; i < parts.length; i++) {
      if (!currentModel) return undefined;
      const part = parts[i].toLowerCase();
      const field = currentModel.fields.find(
        (f) => f.name.toLowerCase() === part,
      );
      if (!field) return undefined;

      if (i === parts.length - 1) {
        return field.type;
      }
      currentModel = this.findModel(field.type, schema);
    }

    return undefined;
  }

  static parseDynamicQuery(
    rawAiOutput: unknown,
    config?: SecurityConfig,
  ): ParsedDynamicQuery {
    let parsedInput: unknown = rawAiOutput;

    if (typeof rawAiOutput === "string") {
      try {
        parsedInput = JSON.parse(rawAiOutput);
      } catch {
        throw new Error("AI output was not valid JSON.");
      }
    }

    const validatedData = AIQueryResponseSchema.parse(parsedInput);

    const targetTable =
      typeof validatedData.targetTable === "string"
        ? validatedData.targetTable.trim()
        : "";
    if (!targetTable) {
      throw new Error(
        "Security Exception: AI output did not include a valid targetTable.",
      );
    }

    // Validate root table
    this.validatePath(targetTable, config, "table");

    // Build conditions (expanding dot-notation paths into nested Prisma relational filters)
    const conditions = validatedData.filters.map((filter) => {
      const normalizedField = filter.field.trim();

      // Validate full field path
      this.validatePath(normalizedField, config, "field", targetTable);

      const expectedType = this.lookupFieldType(
        targetTable,
        normalizedField,
        config?.schemaContext,
      );
      const normalizedValue = this.normalizeFilterValue(
        filter,
        expectedType,
        config?.schemaContext,
      );

      const fieldParts = normalizedField
        .split(".")
        .map((p) => p.trim())
        .filter(Boolean);
      return this.buildNestedCondition(
        fieldParts,
        filter.operator,
        normalizedValue,
        targetTable,
        config?.schemaContext,
      );
    });

    const whereClause =
      conditions.length === 0
        ? {}
        : { [validatedData.logicalOperator]: conditions };

    const result: ParsedDynamicQuery = {
      targetTable,
      where: whereClause,
    };

    // Sanitize and attach multi-level include or select (mutually exclusive in Prisma at root)
    if (
      validatedData.select &&
      typeof validatedData.select === "object" &&
      Object.keys(validatedData.select).length > 0
    ) {
      result.select = this.sanitizeTree(
        validatedData.select,
        "",
        config,
        targetTable,
      );
    } else if (
      validatedData.include &&
      typeof validatedData.include === "object" &&
      Object.keys(validatedData.include).length > 0
    ) {
      result.include = this.sanitizeTree(
        validatedData.include,
        "",
        config,
        targetTable,
      );
    }

    // Sanitize and attach ordering
    if (validatedData.orderBy) {
      result.orderBy = this.sanitizeOrderBy(
        validatedData.orderBy,
        config,
        targetTable,
      );
    }

    // Attach pagination
    if (typeof validatedData.take === "number") {
      result.take = validatedData.take;
    }
    if (typeof validatedData.skip === "number") {
      result.skip = validatedData.skip;
    }

    return result;
  }
}
