export type ErrorCode =
  | 'bad_request' | 'unauthorized' | 'forbidden' | 'not_found' | 'conflict'
  | 'unprocessable' | 'rate_limited' | 'upstream_failed' | 'budget_exhausted'
  | 'timeout' | 'unsupported_media' | 'internal' | 'safety_blocked';

const STATUS: Record<ErrorCode, number> = {
  bad_request: 400, unauthorized: 401, forbidden: 403, not_found: 404,
  conflict: 409, unprocessable: 422, rate_limited: 429, upstream_failed: 502,
  budget_exhausted: 402, timeout: 504, unsupported_media: 415, internal: 500,
  safety_blocked: 451,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { details?: unknown; retryable?: boolean; cause?: unknown } = {}) {
    super(message, opts.cause ? { cause: opts.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = opts.details;
    this.retryable = opts.retryable ?? (code === 'upstream_failed' || code === 'timeout' || code === 'rate_limited');
  }

  toJSON() {
    return { error: { code: this.code, message: this.message, details: this.details } };
  }
}

export const badRequest = (m: string, d?: unknown) => new AppError('bad_request', m, { details: d });
export const notFound = (what: string, idv?: string) =>
  new AppError('not_found', idv ? `${what} '${idv}' not found` : `${what} not found`);
export const conflict = (m: string, d?: unknown) => new AppError('conflict', m, { details: d });
export const unprocessable = (m: string, d?: unknown) => new AppError('unprocessable', m, { details: d });
export const upstream = (m: string, cause?: unknown) => new AppError('upstream_failed', m, { cause });
export const safetyBlocked = (m: string, d?: unknown) => new AppError('safety_blocked', m, { details: d });

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  return typeof e === 'string' ? e : JSON.stringify(e);
}
