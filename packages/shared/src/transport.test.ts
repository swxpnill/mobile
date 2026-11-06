import { expect, it } from 'vitest';
import { NetworkError } from './index.ts';

it('NetworkError is an Error named NetworkError', () => {
  const e = new NetworkError('offline');
  expect(e).toBeInstanceOf(Error);
  expect(e).toBeInstanceOf(NetworkError);
  expect(e.name).toBe('NetworkError');
  expect(e.message).toBe('offline');
});
