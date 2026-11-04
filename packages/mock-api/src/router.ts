import type { Action, HttpMethod, PlantScope } from '@tonnage/shared';
import type { z } from 'zod';
import type { MockState, UserRec } from './store.ts';

export interface HandlerCtx<B = unknown, Q = Record<string, string>> {
  /** Signed-in user; undefined only on `public` routes. */
  user: UserRec | undefined;
  /** `plantScope(user)`; undefined only on `public` routes. */
  scope: PlantScope | undefined;
  params: Record<string, string>;
  query: Q;
  body: B;
  state: MockState;
  /** Request time in ms from the injected clock. */
  now: number;
}

export interface HandlerResult {
  status?: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RouteConfig<B = unknown, Q = Record<string, string>> {
  public?: true;
  action?: Action;
  idempotent?: true;
  body?: z.ZodType<B>;
  query?: z.ZodType<Q>;
  handler(ctx: HandlerCtx<B, Q>): Promise<HandlerResult>;
}

export interface RouteDef extends RouteConfig<unknown, unknown> {
  method: HttpMethod;
  pattern: string;
}

/** Declares a route; mirrors the B1 Fastify route config (`public` / `action` / `idempotent`). */
export function route<B = undefined, Q = Record<string, string>>(
  method: HttpMethod,
  pattern: string,
  config: RouteConfig<B, Q>,
): RouteDef {
  return { method, pattern, ...(config as RouteConfig<unknown, unknown>) };
}

export interface RouteMatch {
  route: RouteDef;
  params: Record<string, string>;
  query: Record<string, string>;
}

export interface Router {
  match(method: HttpMethod, path: string): RouteMatch | null;
}

function decode(s: string): string {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
}

/** Minimal query parser (no URLSearchParams dependency, for Hermes). Last value wins. */
export function parseQuery(qs: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of qs.split('&')) {
    if (part === '') continue;
    const eq = part.indexOf('=');
    const k = decode(eq === -1 ? part : part.slice(0, eq));
    out[k] = eq === -1 ? '' : decode(part.slice(eq + 1));
  }
  return out;
}

const splitPath = (p: string) => p.split('/').filter((s) => s !== '');

export function buildRouter(routes: readonly RouteDef[]): Router {
  const seen = new Set<string>();
  for (const r of routes) {
    const name = `${r.method} ${r.pattern}`;
    if (!r.public && !r.action) throw new Error(`Route ${name} must declare action or public`);
    if (r.public && r.idempotent)
      throw new Error(`Route ${name}: public routes cannot be idempotent`);
    const shape = `${r.method} ${splitPath(r.pattern)
      .map((s) => (s.startsWith(':') ? ':' : s))
      .join('/')}`;
    if (seen.has(shape)) throw new Error(`Duplicate route ${name}`);
    seen.add(shape);
  }
  const compiled = routes.map((r) => ({ route: r, segments: splitPath(r.pattern) }));

  return {
    match(method, fullPath) {
      const q = fullPath.indexOf('?');
      const path = q === -1 ? fullPath : fullPath.slice(0, q);
      const query = q === -1 ? {} : parseQuery(fullPath.slice(q + 1));
      const parts = splitPath(path);
      for (const { route: r, segments } of compiled) {
        if (r.method !== method || segments.length !== parts.length) continue;
        const params: Record<string, string> = {};
        const ok = segments.every((seg, i) => {
          const part = parts[i] ?? '';
          if (seg.startsWith(':')) {
            params[seg.slice(1)] = decode(part);
            return true;
          }
          return seg === part;
        });
        if (ok) return { route: r, params, query };
      }
      return null;
    },
  };
}
