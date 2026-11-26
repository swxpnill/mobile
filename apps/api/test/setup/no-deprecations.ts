import { afterEach } from 'vitest';

/**
 * Fails the test during which a DeprecationWarning was emitted (e.g. pg's "client.query() when the
 * client is already executing a query", which concurrent queries on one transaction cause and pg@9
 * turns into an error). Only DeprecationWarning: other process warnings keep their usual handling.
 */
const seen: string[] = [];
process.on('warning', (w) => {
  if (w.name === 'DeprecationWarning') seen.push(`${w.name}: ${w.message}`);
});

afterEach(async () => {
  // Node emits warnings on the next tick; let any pending one arrive before checking.
  await new Promise((resolve) => setImmediate(resolve));
  const found = seen.splice(0);
  if (found.length > 0) throw new Error(`Deprecation warning(s) during this test:\n${found.join('\n')}`);
});
