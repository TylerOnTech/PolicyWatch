import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

// Resolves to <repo>/openapi/openapi.yaml from both src/api (tsx) and dist/api (compiled).
const SPEC_PATH = fileURLToPath(new URL('../../openapi/openapi.yaml', import.meta.url));

let cached: Record<string, unknown> | undefined;

export function loadOpenApiSpec(): Record<string, unknown> {
  cached ??= parse(readFileSync(SPEC_PATH, 'utf8')) as Record<string, unknown>;
  return cached;
}
