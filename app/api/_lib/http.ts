// Shared helpers for app/api route handlers: JSON responses, error mapping, zod parsing.
import { z } from 'zod';
import type { ApiError } from '../../../lib/queries/api-types';

export function json<T>(body: T, status = 200): Response {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
}

export function error(status: number, message: string, details?: unknown): Response {
  const body: ApiError = details === undefined ? { error: message } : { error: message, details };
  return json(body, status);
}

export function notFound(what: string): Response {
  return error(404, `${what} not found`);
}

/** Parse a JSON request body with a zod schema; returns the data or a 400 response. */
export async function parseBody<S extends z.ZodTypeAny>(req: Request, schema: S): Promise<{ ok: true; data: z.infer<S> } | { ok: false; res: Response }> {
  let raw: unknown;
  try {
    const text = await req.text();
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch {
    return { ok: false, res: error(400, 'invalid JSON body') };
  }
  const r = schema.safeParse(raw);
  if (!r.success) return { ok: false, res: error(400, 'validation failed', r.error.issues) };
  return { ok: true, data: r.data };
}

export function parseQuery<S extends z.ZodTypeAny>(req: Request, schema: S): { ok: true; data: z.infer<S> } | { ok: false; res: Response } {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const r = schema.safeParse(params);
  if (!r.success) return { ok: false, res: error(400, 'invalid query', r.error.issues) };
  return { ok: true, data: r.data };
}

export const idParam = z.coerce.number().int().positive();

export function parseId(raw: string): number | null {
  const r = idParam.safeParse(raw);
  return r.success ? r.data : null;
}

/** Wrap a handler so unexpected errors become a logged 500 JSON response. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response): (...args: A) => Promise<Response> {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (err) {
      console.error('[api]', err);
      return error(500, err instanceof Error ? err.message : 'internal error');
    }
  };
}

export const chainSchema = z.enum(['ethereum', 'arbitrum']);
export const addressSchema = z
  .string()
  .trim()
  .regex(/^0x[0-9a-fA-F]{40}$/, 'expected a 0x prefixed 20 byte hex address')
  .transform((s) => s.toLowerCase());
export const colorSchema = z
  .string()
  .trim()
  .regex(/^#[0-9a-fA-F]{3,8}$/, 'expected a hex color like #ea5a1f');
export const rangeSchema = z.enum(['24h', '7d', '30d', '90d', '1y', 'all']);
export const groupBySchema = z.enum(['none', 'chain', 'wallet', 'protocol']);
