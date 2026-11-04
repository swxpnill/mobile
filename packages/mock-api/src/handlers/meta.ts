import { toIso } from '../clock.ts';
import { route, type RouteDef } from '../router.ts';

export const MIN_SUPPORTED_VERSION = '1.0.0';

export const metaRoutes: RouteDef[] = [
  route('GET', '/v1/meta', {
    public: true,
    async handler({ now }) {
      return { body: { minSupportedVersion: MIN_SUPPORTED_VERSION, serverTime: toIso(now) } };
    },
  }),
];
