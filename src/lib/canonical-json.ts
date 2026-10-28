/**
 * Deterministic JSON serialization: object keys sorted by code unit, `undefined` members dropped,
 * array order preserved (callers sort semantically meaningful arrays before hashing). Used to derive
 * content hashes for snapshot de-duplication, never for change detection itself.
 */
export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'string':
    case 'boolean':
      return JSON.stringify(value);
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('canonicalJson: non-finite number');
      return JSON.stringify(value);
    case 'object': {
      if (value instanceof Date) return JSON.stringify(value.toISOString());
      if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? 'null' : serialize(v))).join(',')}]`;
      const entries = Object.entries(value as Record<string, unknown>)
        .filter(([, v]) => v !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${serialize(v)}`).join(',')}}`;
    }
    default:
      throw new TypeError(`canonicalJson: unsupported type ${typeof value}`);
  }
}
