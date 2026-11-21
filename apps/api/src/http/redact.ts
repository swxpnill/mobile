import { redactForRole, type Role } from '@tonnage/shared';

/**
 * A JSON round-trip: what the wire does to a handler's body (Dates become strings, `undefined`
 * keys go). It also guarantees plain objects, which `redactForRole` needs to see into.
 */
export function toWire(value: unknown): unknown {
  return value === undefined ? undefined : (JSON.parse(JSON.stringify(value)) as unknown);
}

/** The body a caller of this role may see: money keys omitted at any depth for plant roles. */
export function redactBody(role: Role, body: unknown): unknown {
  return redactForRole(role, body);
}
