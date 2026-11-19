import type { PushMessage } from '@tonnage/shared';
import { API_MODE, getMockApi } from '../api/transport';

/**
 * Where pushes come from, the one seam for push (F5 Ruling 1). Mock mode: the in-app mock's
 * push worker. Real mode (B4): the Expo push token and expo-notifications listeners; until then
 * there is no token, and the list and badge still work by polling.
 */
export interface PushChannel {
  /** This phone's push address, or null when push is not available. */
  token(deviceId: string): string | null;
  /** Messages for `token` only. Returns unsubscribe. */
  subscribe(token: string, onMessage: (m: PushMessage['message']) => void): () => void;
}

export async function getPushChannel(): Promise<PushChannel> {
  if (API_MODE !== 'mock') return { token: () => null, subscribe: () => () => undefined };
  const mock = await getMockApi();
  return {
    token: (deviceId) => `mock:${deviceId}`,
    // The in-process worker hands out every phone's pushes; a real phone only receives its own.
    subscribe: (token, onMessage) => mock.controls.onPush((m) => m.token === token && onMessage(m.message)),
  };
}
