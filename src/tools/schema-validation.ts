export class ToolSchemaValidationError extends Error {
  constructor(
    public readonly path: string,
    message: string,
  ) {
    super(message);
    this.name = 'ToolSchemaValidationError';
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (value == null || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? value as Record<string, unknown>
    : null;
}

function schemaRecord(value: unknown, path: string): Record<string, unknown> {
  const parsed = record(value);
  if (!parsed) throw new ToolSchemaValidationError(path, 'Registered tool schema is invalid.');
  return parsed;
}

function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function matchesFormat(value: string, format: unknown): boolean {
  if (format === undefined) return true;
  if (format === 'date') return isIsoDate(value);
  if (format === 'uri') {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  return false;
}

function validateNode(schemaValue: unknown, value: unknown, path: string): void {
  const schema = schemaRecord(schemaValue, path);
  if (Array.isArray(schema.enum)) {
    if (!schema.enum.some((candidate) => Object.is(candidate, value))) {
      throw new ToolSchemaValidationError(path, 'Value is not in the allowed enum.');
    }
    return;
  }

  if (schema.type === 'object') {
    const object = record(value);
    if (!object) throw new ToolSchemaValidationError(path, 'Expected an object.');
    const properties = schemaRecord(schema.properties ?? {}, path);
    const required = Array.isArray(schema.required)
      ? schema.required.filter((item): item is string => typeof item === 'string')
      : [];
    for (const key of required) {
      if (!Object.hasOwn(object, key)) {
        throw new ToolSchemaValidationError(`${path}.${key}`, 'Required value is missing.');
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(object)) {
        if (!Object.hasOwn(properties, key)) {
          throw new ToolSchemaValidationError(`${path}.${key}`, 'Unknown value is not allowed.');
        }
      }
    }
    for (const [key, propertySchema] of Object.entries(properties)) {
      if (Object.hasOwn(object, key)) validateNode(propertySchema, object[key], `${path}.${key}`);
    }
    return;
  }

  if (schema.type === 'array') {
    if (!Array.isArray(value)) throw new ToolSchemaValidationError(path, 'Expected an array.');
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) {
      throw new ToolSchemaValidationError(path, 'Array has too few items.');
    }
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) {
      throw new ToolSchemaValidationError(path, 'Array has too many items.');
    }
    value.forEach((item, index) => validateNode(schema.items, item, `${path}[${index}]`));
    return;
  }

  if (schema.type === 'string') {
    if (typeof value !== 'string') throw new ToolSchemaValidationError(path, 'Expected a string.');
    if (typeof schema.minLength === 'number' && value.length < schema.minLength) {
      throw new ToolSchemaValidationError(path, 'String is too short.');
    }
    if (typeof schema.maxLength === 'number' && value.length > schema.maxLength) {
      throw new ToolSchemaValidationError(path, 'String is too long.');
    }
    if (!matchesFormat(value, schema.format)) {
      throw new ToolSchemaValidationError(path, 'String format is invalid.');
    }
    return;
  }

  if (schema.type === 'integer') {
    if (!Number.isInteger(value)) throw new ToolSchemaValidationError(path, 'Expected an integer.');
    const number = value as number;
    if (typeof schema.minimum === 'number' && number < schema.minimum) {
      throw new ToolSchemaValidationError(path, 'Number is below the minimum.');
    }
    if (typeof schema.maximum === 'number' && number > schema.maximum) {
      throw new ToolSchemaValidationError(path, 'Number is above the maximum.');
    }
    return;
  }

  throw new ToolSchemaValidationError(path, 'Registered tool schema uses an unsupported keyword.');
}

export function validateToolArguments(
  schema: Record<string, unknown>,
  value: unknown,
): Record<string, unknown> {
  validateNode(schema, value, '$');
  return structuredClone(value as Record<string, unknown>);
}
