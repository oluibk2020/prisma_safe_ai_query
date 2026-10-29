import * as fs from "fs";
import * as path from "path";

export interface ExtractedField {
  name: string;
  type: string;
  isList: boolean;
  isRequired: boolean;
  relation?: boolean;
  relationFromFields?: string[];
  relationToFields?: string[];
}

export interface ExtractedModel {
  name: string;
  fields: ExtractedField[];
}

export interface ExtractedEnum {
  name: string;
  values: string[];
}

export interface ExtractedSchema {
  models: ExtractedModel[];
  enums: ExtractedEnum[];
}

/**
 * Searches default standard locations for schema.prisma if no explicit path is given.
 */
export function findPrismaSchemaPath(customPath?: string): string | null {
  if (customPath) {
    const resolved = path.resolve(customPath);
    if (fs.existsSync(resolved)) return resolved;
    return null;
  }

  const defaultLocations = [
    path.resolve(process.cwd(), "prisma", "schema.prisma"),
    path.resolve(process.cwd(), "schema.prisma"),
  ];

  for (const loc of defaultLocations) {
    if (fs.existsSync(loc)) return loc;
  }

  return null;
}

const SCALAR_TYPES = new Set([
  "String",
  "Int",
  "Float",
  "Boolean",
  "DateTime",
  "Json",
  "Bytes",
  "Decimal",
  "BigInt",
]);

/**
 * Parses raw schema.prisma contents into structured models, relations, foreign keys, and enums,
 * filtering out datasource URLs, generators, comments, and private credentials.
 */
export function parsePrismaSchemaText(schemaContent: string): ExtractedSchema {
  const lines = schemaContent.split(/\r?\n/);
  const models: ExtractedModel[] = [];
  const enums: ExtractedEnum[] = [];

  let currentModel: ExtractedModel | null = null;
  let currentEnum: ExtractedEnum | null = null;

  for (const rawLine of lines) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;

    const modelStartMatch = line.match(/^model\s+([A-Za-z0-9_]+)\s*\{/);
    if (modelStartMatch) {
      currentModel = { name: modelStartMatch[1], fields: [] };
      continue;
    }

    const enumStartMatch = line.match(/^enum\s+([A-Za-z0-9_]+)\s*\{/);
    if (enumStartMatch) {
      currentEnum = { name: enumStartMatch[1], values: [] };
      continue;
    }

    if (line === "}" || line.startsWith("}")) {
      if (currentModel) {
        models.push(currentModel);
        currentModel = null;
      }
      if (currentEnum) {
        enums.push(currentEnum);
        currentEnum = null;
      }
      continue;
    }

    if (currentEnum) {
      const enumVal = line.trim();
      if (enumVal && /^[A-Za-z0-9_]+$/.test(enumVal)) {
        currentEnum.values.push(enumVal);
      }
      continue;
    }

    if (currentModel) {
      if (line.startsWith("@@")) continue;

      const tokens = line.split(/\s+/).filter(Boolean);
      if (tokens.length >= 2) {
        const fieldName = tokens[0];
        const fieldType = tokens[1];

        if (fieldName.startsWith("@")) continue;

        const isList = fieldType.endsWith("[]");
        const isRequired = !fieldType.endsWith("?");
        const cleanType = fieldType.replace(/[?\[\]]/g, "");

        // Extract @relation(fields: [userId], references: [id]) if present
        let relationFromFields: string[] | undefined;
        let relationToFields: string[] | undefined;

        const fieldsMatch = line.match(/fields:\s*\[([^\]]+)\]/);
        if (fieldsMatch) {
          relationFromFields = fieldsMatch[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }

        const refsMatch = line.match(/references:\s*\[([^\]]+)\]/);
        if (refsMatch) {
          relationToFields = refsMatch[1]
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean);
        }

        const isExplicitRelation =
          line.includes("@relation") || !SCALAR_TYPES.has(cleanType);

        currentModel.fields.push({
          name: fieldName,
          type: cleanType,
          isList,
          isRequired,
          relation: isExplicitRelation,
          ...(relationFromFields ? { relationFromFields } : {}),
          ...(relationToFields ? { relationToFields } : {}),
        });
      }
    }
  }

  // Post-process: Ensure fields whose type is an Enum are marked as non-relations
  const enumNames = new Set(enums.map((e) => e.name));
  for (const model of models) {
    for (const field of model.fields) {
      if (enumNames.has(field.type)) {
        field.relation = false;
      }
    }
  }

  return { models, enums };
}

/**
 * Extracts schema information from a Prisma client instance, DMMF, _runtimeDataModel, or schema file.
 */
export function extractPrismaSchema(
  input?: string | { _dmmf?: any; _runtimeDataModel?: any; dmmf?: any } | any,
): ExtractedSchema {
  if (input && typeof input === "object") {
    // 1. Standard DMMF format (Array of models)
    const dmmf = input.dmmf || input._dmmf;
    if (dmmf?.datamodel?.models && Array.isArray(dmmf.datamodel.models)) {
      return {
        models: dmmf.datamodel.models.map((m: any) => ({
          name: m.name,
          fields: (m.fields || []).map((f: any) => ({
            name: f.name,
            type: f.type,
            isList: Boolean(f.isList),
            isRequired: Boolean(f.isRequired),
            relation: f.kind === "object",
            ...(f.relationFromFields?.length
              ? { relationFromFields: f.relationFromFields }
              : {}),
            ...(f.relationToFields?.length
              ? { relationToFields: f.relationToFields }
              : {}),
          })),
        })),
        enums: (dmmf.datamodel.enums || []).map((e: any) => ({
          name: e.name,
          values: (e.values || []).map((v: any) =>
            typeof v === "string" ? v : v.name,
          ),
        })),
      };
    }

    // 2. Prisma v5/v6/v7 _runtimeDataModel format (Record map of models)
    const runtimeModel =
      input._runtimeDataModel ||
      (input.models && !Array.isArray(input.models) ? input : null);
    if (runtimeModel?.models && typeof runtimeModel.models === "object") {
      const models: ExtractedModel[] = Object.entries(runtimeModel.models).map(
        ([modelName, m]: [string, any]) => ({
          name: modelName,
          fields: (m.fields || []).map((f: any) => ({
            name: f.name,
            type: f.type,
            isList: Boolean(f.isList),
            isRequired: Boolean(f.isRequired),
            relation: f.kind === "object",
            ...(f.relationFromFields?.length
              ? { relationFromFields: f.relationFromFields }
              : {}),
            ...(f.relationToFields?.length
              ? { relationToFields: f.relationToFields }
              : {}),
          })),
        }),
      );

      const enums: ExtractedEnum[] = runtimeModel.enums
        ? Object.entries(runtimeModel.enums).map(
            ([enumName, e]: [string, any]) => ({
              name: enumName,
              values: (e.values || []).map((v: any) =>
                typeof v === "string" ? v : v.name,
              ),
            }),
          )
        : [];

      return { models, enums };
    }
  }

  // 3. File path resolution
  const filePath = findPrismaSchemaPath(
    typeof input === "string" ? input : undefined,
  );
  if (!filePath) {
    return { models: [], enums: [] };
  }

  const content = fs.readFileSync(filePath, "utf-8");
  return parsePrismaSchemaText(content);
}

/**
 * Formats extracted schema models, foreign-key relationships, and enums into an AI-digestible context string.
 */
export function formatSchemaForAIContext(schema: ExtractedSchema): string {
  if (!schema.models.length && !schema.enums.length) {
    return "";
  }

  const parts: string[] = [];

  if (schema.models.length > 0) {
    parts.push("Database Models and Relations:");
    for (const m of schema.models) {
      const camelModelName = m.name.charAt(0).toLowerCase() + m.name.slice(1);
      const fieldStrs = m.fields.map((f) => {
        let descriptor = `${f.name}: ${f.type}${f.isList ? "[]" : ""}${!f.isRequired ? "?" : ""}`;
        if (f.relation) {
          if (f.relationFromFields?.length && f.relationToFields?.length) {
            descriptor += ` (relation to ${f.type} via ${f.relationFromFields.join(",")} -> ${f.relationToFields.join(",")})`;
          } else {
            descriptor += ` (relation to ${f.type})`;
          }
        }
        return descriptor;
      });
      parts.push(
        `- Model ${m.name} (targetTable: "${camelModelName}") { ${fieldStrs.join(", ")} }`,
      );
    }
  }

  if (schema.enums.length > 0) {
    parts.push("Database Enums:");
    for (const e of schema.enums) {
      parts.push(`- Enum ${e.name} [${e.values.join(", ")}]`);
    }
  }

  return parts.join("\n");
}
