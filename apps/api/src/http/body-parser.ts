import type { FastifyInstance } from 'fastify';

const BAD_BODY = Symbol('bad body');

/** Stands in for a body that could not be parsed; the 422 is raised where the body is validated. */
export interface BadBody {
  readonly [BAD_BODY]: string;
}

const badBody = (message: string): BadBody => Object.freeze({ [BAD_BODY]: message });

/** The reason a body could not be parsed, or null for a parsed body. */
export function badBodyReason(value: unknown): string | null {
  return typeof value === 'object' && value !== null && BAD_BODY in value
    ? (value as BadBody)[BAD_BODY]
    : null;
}

/**
 * Body parsers that never fail the request themselves. Fastify parses before the route handler,
 * so a parser error would reach the caller before auth and policy (Ruling 10: an unauthenticated
 * or forbidden caller never sees a body error). Malformed JSON and other content types become a
 * `BadBody` that body validation turns into 422 VALIDATION; an empty JSON body is no body.
 */
export function registerBodyParsers(app: FastifyInstance): void {
  // Fastify's own JSON parser, so prototype and constructor poisoning are still refused.
  const json = app.getDefaultJsonParser('error', 'error');
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, raw, done) => {
    const text = typeof raw === 'string' ? raw : raw.toString('utf8');
    if (text === '') {
      done(null, undefined);
      return;
    }
    json(req, text, (err, value) => done(null, err ? badBody('Body is not valid JSON') : value));
  });
  app.addContentTypeParser('*', { parseAs: 'string' }, (_req, _raw, done) => {
    done(null, badBody('Unsupported content type'));
  });
}
