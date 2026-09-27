// Minimal JSON Schema (draft 2020-12 subset) validator for the keywords used by
// schemas/resource-manifest-v0.schema.json. It avoids adding a dependency to
// this repo. Unknown keywords are ignored, so keep this list in sync with the
// schema if the published schema starts using new keywords.

export type JsonSchema = Record<string, unknown> | boolean;

export const SUPPORTED_KEYWORDS = new Set([
  "$schema",
  "$id",
  "$ref",
  "$defs",
  "title",
  "description",
  "default",
  "type",
  "enum",
  "const",
  "required",
  "properties",
  "additionalProperties",
  "propertyNames",
  "items",
  "minItems",
  "uniqueItems",
  "minLength",
  "maxLength",
  "pattern",
  "minimum",
  "maximum",
  "not",
  "oneOf",
  "anyOf",
  "allOf"
]);

export function validateJsonSchema(rootSchema: Record<string, unknown>, value: unknown): string[] {
  const errors: string[] = [];
  validateNode(rootSchema, rootSchema, value, "", errors);
  return errors;
}

export function listUnsupportedKeywords(schema: unknown): string[] {
  const found = new Set<string>();
  const walk = (node: unknown, parentKey: string | null): void => {
    if (Array.isArray(node)) {
      for (const item of node) walk(item, null);
      return;
    }
    if (!isObject(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (parentKey !== "properties" && parentKey !== "$defs" && !SUPPORTED_KEYWORDS.has(key)) found.add(key);
      if (key === "enum" || key === "const" || key === "default" || key === "required") continue;
      walk(child, key === "properties" || key === "$defs" ? key : null);
    }
  };
  walk(schema, null);
  return [...found].sort();
}

function validateNode(root: Record<string, unknown>, schema: JsonSchema, value: unknown, pointer: string, errors: string[]): void {
  if (schema === true) return;
  if (schema === false) {
    errors.push(`${pointer || "/"} is not allowed`);
    return;
  }

  if (typeof schema.$ref === "string") {
    validateNode(root, resolveRef(root, schema.$ref), value, pointer, errors);
  }

  if (schema.type !== undefined) {
    const types = Array.isArray(schema.type) ? (schema.type as string[]) : [schema.type as string];
    if (!types.some((type) => matchesType(type, value))) {
      errors.push(`${pointer || "/"} must be ${types.join(" or ")}`);
      return;
    }
  }

  if (Array.isArray(schema.enum) && !schema.enum.some((candidate) => deepEqual(candidate, value))) {
    errors.push(`${pointer || "/"} must be one of ${schema.enum.map((item) => JSON.stringify(item)).join(", ")}`);
  }
  if ("const" in schema && !deepEqual(schema.const, value)) {
    errors.push(`${pointer || "/"} must equal ${JSON.stringify(schema.const)}`);
  }

  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) errors.push(`${pointer} is shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === "number" && length > schema.maxLength) errors.push(`${pointer} is longer than ${schema.maxLength}`);
    if (typeof schema.pattern === "string" && !compilePattern(schema.pattern).test(value)) {
      errors.push(`${pointer} does not match ${schema.pattern}`);
    }
  }

  if (typeof value === "number") {
    if (typeof schema.minimum === "number" && value < schema.minimum) errors.push(`${pointer} must be >= ${schema.minimum}`);
    if (typeof schema.maximum === "number" && value > schema.maximum) errors.push(`${pointer} must be <= ${schema.maximum}`);
  }

  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) errors.push(`${pointer} needs at least ${schema.minItems} items`);
    if (schema.uniqueItems === true) {
      const seen = new Set(value.map((item) => JSON.stringify(item)));
      if (seen.size !== value.length) errors.push(`${pointer} items must be unique`);
    }
    if (schema.items !== undefined) {
      value.forEach((item, index) => validateNode(root, schema.items as JsonSchema, item, `${pointer}/${index}`, errors));
    }
  }

  if (isObject(value)) {
    if (Array.isArray(schema.required)) {
      for (const key of schema.required as string[]) {
        if (!(key in value)) errors.push(`${pointer || "/"} is missing required property ${key}`);
      }
    }
    const properties = isObject(schema.properties) ? (schema.properties as Record<string, JsonSchema>) : {};
    for (const [key, child] of Object.entries(value)) {
      const childPointer = `${pointer}/${key}`;
      if (schema.propertyNames !== undefined) {
        validateNode(root, schema.propertyNames as JsonSchema, key, `${childPointer} (name)`, errors);
      }
      if (key in properties) {
        validateNode(root, properties[key]!, child, childPointer, errors);
      } else if (schema.additionalProperties !== undefined) {
        validateNode(root, schema.additionalProperties as JsonSchema, child, childPointer, errors);
      }
    }
  }

  if (schema.not !== undefined && collect(root, schema.not as JsonSchema, value, pointer).length === 0) {
    errors.push(`${pointer || "/"} matches a disallowed value`);
  }
  if (Array.isArray(schema.allOf)) {
    for (const child of schema.allOf as JsonSchema[]) validateNode(root, child, value, pointer, errors);
  }
  if (Array.isArray(schema.anyOf)) {
    const passes = (schema.anyOf as JsonSchema[]).some((child) => collect(root, child, value, pointer).length === 0);
    if (!passes) errors.push(`${pointer || "/"} does not match any allowed shape`);
  }
  if (Array.isArray(schema.oneOf)) {
    const passing = (schema.oneOf as JsonSchema[]).filter((child) => collect(root, child, value, pointer).length === 0).length;
    if (passing !== 1) errors.push(`${pointer || "/"} must match exactly one allowed shape (matched ${passing})`);
  }
}

function collect(root: Record<string, unknown>, schema: JsonSchema, value: unknown, pointer: string): string[] {
  const errors: string[] = [];
  validateNode(root, schema, value, pointer, errors);
  return errors;
}

const patternCache = new Map<string, RegExp>();

// JSON Schema patterns are ECMA-262 regexes. Prefer unicode mode, but fall back
// to legacy mode for patterns that use identity escapes such as \" that the
// unicode flag rejects.
function compilePattern(pattern: string): RegExp {
  let compiled = patternCache.get(pattern);
  if (!compiled) {
    try {
      compiled = new RegExp(pattern, "u");
    } catch {
      compiled = new RegExp(pattern);
    }
    patternCache.set(pattern, compiled);
  }
  return compiled;
}

function resolveRef(root: Record<string, unknown>, ref: string): JsonSchema {
  if (!ref.startsWith("#/")) throw new Error(`Only local $ref values are supported: ${ref}`);
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (!isObject(node) || !(key in node)) throw new Error(`Unresolvable $ref: ${ref}`);
    node = node[key];
  }
  if (!isObject(node) && typeof node !== "boolean") throw new Error(`Invalid $ref target: ${ref}`);
  return node as JsonSchema;
}

function matchesType(type: string, value: unknown): boolean {
  switch (type) {
    case "object":
      return isObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      throw new Error(`Unsupported JSON schema type: ${type}`);
  }
}

function deepEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
