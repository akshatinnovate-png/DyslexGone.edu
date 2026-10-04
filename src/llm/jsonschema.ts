/** A compact JSON Schema subset: validate, coerce, synthesize, and describe.
 *  Used to constrain model output and to fabricate schema-valid offline results. */

export type JsonSchema =
  | { type: 'string'; description?: string; enum?: string[]; minLength?: number; maxLength?: number; example?: string }
  | { type: 'number' | 'integer'; description?: string; minimum?: number; maximum?: number; example?: number }
  | { type: 'boolean'; description?: string; example?: boolean }
  | { type: 'null'; description?: string }
  | { type: 'array'; description?: string; items: JsonSchema; minItems?: number; maxItems?: number }
  | {
      type: 'object';
      description?: string;
      properties: Record<string, JsonSchema>;
      required?: string[];
      additionalProperties?: boolean;
    };

export interface ValidationIssue { path: string; message: string; }

export function validate(value: unknown, schema: JsonSchema, path = '$'): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const fail = (m: string) => issues.push({ path, message: m });

  switch (schema.type) {
    case 'string': {
      if (typeof value !== 'string') { fail(`expected string, got ${typeOf(value)}`); break; }
      if (schema.enum && !schema.enum.includes(value)) fail(`expected one of ${schema.enum.join('|')}`);
      if (schema.minLength !== undefined && value.length < schema.minLength) fail(`shorter than ${schema.minLength}`);
      if (schema.maxLength !== undefined && value.length > schema.maxLength) fail(`longer than ${schema.maxLength}`);
      break;
    }
    case 'number':
    case 'integer': {
      if (typeof value !== 'number' || !Number.isFinite(value)) { fail(`expected number, got ${typeOf(value)}`); break; }
      if (schema.type === 'integer' && !Number.isInteger(value)) fail('expected integer');
      if (schema.minimum !== undefined && value < schema.minimum) fail(`below minimum ${schema.minimum}`);
      if (schema.maximum !== undefined && value > schema.maximum) fail(`above maximum ${schema.maximum}`);
      break;
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail(`expected boolean, got ${typeOf(value)}`);
      break;
    case 'null':
      if (value !== null) fail('expected null');
      break;
    case 'array': {
      if (!Array.isArray(value)) { fail(`expected array, got ${typeOf(value)}`); break; }
      if (schema.minItems !== undefined && value.length < schema.minItems) fail(`fewer than ${schema.minItems} items`);
      if (schema.maxItems !== undefined && value.length > schema.maxItems) fail(`more than ${schema.maxItems} items`);
      value.forEach((v, i) => issues.push(...validate(v, schema.items, `${path}[${i}]`)));
      break;
    }
    case 'object': {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        fail(`expected object, got ${typeOf(value)}`);
        break;
      }
      const obj = value as Record<string, unknown>;
      for (const key of schema.required ?? []) {
        if (!(key in obj)) fail(`missing required property '${key}'`);
      }
      for (const [key, sub] of Object.entries(schema.properties)) {
        if (key in obj) issues.push(...validate(obj[key], sub, `${path}.${key}`));
      }
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!(key in schema.properties)) fail(`unexpected property '${key}'`);
        }
      }
      break;
    }
  }
  return issues;
}

const typeOf = (v: unknown): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v);

/** Best-effort coercion so a slightly-off model response still lands. */
export function coerce(value: unknown, schema: JsonSchema): unknown {
  switch (schema.type) {
    case 'string':
      if (typeof value === 'string') return schema.enum && !schema.enum.includes(value)
        ? (closestEnum(value, schema.enum) ?? schema.enum[0]) : value;
      if (value === null || value === undefined) return schema.enum?.[0] ?? '';
      if (typeof value === 'object') return JSON.stringify(value);
      return String(value);
    case 'number':
    case 'integer': {
      const n = typeof value === 'number' ? value : Number(String(value ?? '').replace(/[^\d.eE+-]/g, ''));
      const v = Number.isFinite(n) ? n : (schema.minimum ?? 0);
      const clamped = Math.min(schema.maximum ?? Infinity, Math.max(schema.minimum ?? -Infinity, v));
      return schema.type === 'integer' ? Math.round(clamped) : clamped;
    }
    case 'boolean':
      if (typeof value === 'boolean') return value;
      return /^(1|true|yes|y)$/i.test(String(value));
    case 'null':
      return null;
    case 'array': {
      const arr = Array.isArray(value) ? value : value === null || value === undefined ? [] : [value];
      const mapped = arr.map((v) => coerce(v, schema.items));
      while (schema.minItems !== undefined && mapped.length < schema.minItems) mapped.push(synthesize(schema.items));
      return schema.maxItems !== undefined ? mapped.slice(0, schema.maxItems) : mapped;
    }
    case 'object': {
      const src = (value !== null && typeof value === 'object' && !Array.isArray(value))
        ? (value as Record<string, unknown>) : {};
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.properties)) {
        if (k in src) out[k] = coerce(src[k], sub);
        else if ((schema.required ?? []).includes(k)) out[k] = synthesize(sub);
      }
      if (schema.additionalProperties !== false) {
        for (const [k, v] of Object.entries(src)) if (!(k in out)) out[k] = v;
      }
      return out;
    }
  }
}

function closestEnum(value: string, options: string[]): string | undefined {
  const v = value.toLowerCase().trim();
  return options.find((o) => o.toLowerCase() === v)
    ?? options.find((o) => o.toLowerCase().includes(v) || v.includes(o.toLowerCase()));
}

/** Produce a minimal schema-valid value - the offline provider's safety net. */
export function synthesize(schema: JsonSchema): unknown {
  switch (schema.type) {
    case 'string': return schema.example ?? schema.enum?.[0] ?? (schema.description ? `[${schema.description}]` : '');
    case 'number': return schema.example ?? schema.minimum ?? 0;
    case 'integer': return Math.round(schema.example ?? schema.minimum ?? 0);
    case 'boolean': return schema.example ?? false;
    case 'null': return null;
    case 'array': return Array.from({ length: Math.max(schema.minItems ?? 1, 1) }, () => synthesize(schema.items));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [k, sub] of Object.entries(schema.properties)) {
        if ((schema.required ?? Object.keys(schema.properties)).includes(k)) out[k] = synthesize(sub);
      }
      return out;
    }
  }
}

/** Compact human-readable rendering of a schema, for prompt embedding. */
export function describeSchema(schema: JsonSchema, indent = 0): string {
  const pad = '  '.repeat(indent);
  switch (schema.type) {
    case 'object': {
      const lines = Object.entries(schema.properties).map(([k, v]) => {
        const req = (schema.required ?? []).includes(k) ? '' : '?';
        const desc = v.description ? `  // ${v.description}` : '';
        if (v.type === 'object' || v.type === 'array') {
          return `${pad}  "${k}"${req}: ${describeSchema(v, indent + 1).trimStart()}${desc}`;
        }
        const enumPart = v.type === 'string' && v.enum ? ` (${v.enum.join(' | ')})` : '';
        return `${pad}  "${k}"${req}: ${v.type}${enumPart}${desc}`;
      });
      return `{\n${lines.join(',\n')}\n${pad}}`;
    }
    case 'array':
      return `[ ${describeSchema(schema.items, indent).trimStart()} ]`;
    default:
      return schema.type === 'string' && schema.enum ? `string (${schema.enum.join(' | ')})` : schema.type;
  }
}

/** Pull the first balanced JSON object/array out of arbitrary model prose. */
export function extractJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidates = [fenced?.[1], trimmed].filter(Boolean) as string[];
  for (const c of candidates) {
    try { return JSON.parse(c); } catch { /* keep scanning */ }
    for (const open of ['{', '[']) {
      const start = c.indexOf(open);
      if (start < 0) continue;
      const close = open === '{' ? '}' : ']';
      let depth = 0, inStr = false, esc = false;
      for (let i = start; i < c.length; i++) {
        const ch = c[i];
        if (inStr) {
          if (esc) esc = false;
          else if (ch === '\\') esc = true;
          else if (ch === '"') inStr = false;
          continue;
        }
        if (ch === '"') inStr = true;
        else if (ch === open) depth++;
        else if (ch === close) {
          depth--;
          if (depth === 0) {
            try { return JSON.parse(c.slice(start, i + 1)); } catch { break; }
          }
        }
      }
    }
  }
  return undefined;
}

/* --------------------------- schema shorthands ---------------------------- */

export const S = {
  str: (description?: string, extra: { enum?: string[]; minLength?: number; maxLength?: number; example?: string } = {}) =>
    ({ type: 'string' as const, description, ...extra }),
  enumOf: (values: string[], description?: string) =>
    ({ type: 'string' as const, enum: values, description }),
  num: (description?: string, extra: { minimum?: number; maximum?: number; example?: number } = {}) =>
    ({ type: 'number' as const, description, ...extra }),
  int: (description?: string, extra: { minimum?: number; maximum?: number; example?: number } = {}) =>
    ({ type: 'integer' as const, description, ...extra }),
  bool: (description?: string) => ({ type: 'boolean' as const, description }),
  arr: (items: JsonSchema, description?: string, extra: { minItems?: number; maxItems?: number } = {}) =>
    ({ type: 'array' as const, items, description, ...extra }),
  obj: (properties: Record<string, JsonSchema>, required?: string[], description?: string) =>
    ({ type: 'object' as const, properties, required: required ?? Object.keys(properties), description }),
};
