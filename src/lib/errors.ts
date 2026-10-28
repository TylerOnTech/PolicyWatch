export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export const notFound = (resource: string, id: string) =>
  new ApiError(404, 'RESOURCE_NOT_FOUND', `${resource} '${id}' was not found`);

export const conflict = (code: string, message: string, details?: unknown) => new ApiError(409, code, message, details);

export const badRequest = (code: string, message: string, details?: unknown) =>
  new ApiError(400, code, message, details);

/** Prisma unique-constraint violation (P2002), including when wrapped by an interactive transaction. */
export function isUniqueViolation(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: unknown }).code;
  if (code === 'P2002') return true;
  // Raw queries surface the PostgreSQL SQLSTATE through P2010 / meta.code.
  const meta = (err as { meta?: { code?: unknown } }).meta;
  return code === 'P2010' && meta?.code === '23505';
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
