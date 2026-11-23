import type { Transport, TransportResponse } from '@tonnage/shared';
import type { FastifyInstance } from 'fastify';

/** One string per header, names lower-case; multi-value headers are joined as HTTP folds them. */
function flatHeaders(
  raw: Record<string, string | string[] | number | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (value === undefined) continue;
    out[name.toLowerCase()] = Array.isArray(value) ? value.join(', ') : String(value);
  }
  return out;
}

/** A JSON body parsed; an empty body (a 204) is `undefined`; anything else stays text. */
function parseBody(status: number, contentType: string | undefined, payload: string): unknown {
  if (status === 204 || payload === '') return undefined;
  if (contentType?.includes('application/json')) return JSON.parse(payload) as unknown;
  return payload;
}

/** A `Transport` over `app.inject`: the contract suite talks to the real routes without a socket. */
export function fastifyTransport(app: FastifyInstance): Transport {
  return {
    async request(req): Promise<TransportResponse> {
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(req.headers)) headers[name.toLowerCase()] = value;
      const res = await app.inject({
        method: req.method,
        url: req.path,
        headers,
        ...(req.body !== undefined ? { payload: JSON.stringify(req.body) } : {}),
      });
      const resHeaders = flatHeaders(res.headers);
      return {
        status: res.statusCode,
        headers: resHeaders,
        body: parseBody(res.statusCode, resHeaders['content-type'], res.payload),
      };
    },
  };
}
