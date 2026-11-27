// Shared set-up for the onboarding tests: a mock API, a signed-in person, the providers.
import AsyncStorage from '@react-native-async-storage/async-storage';
import { render } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { SAMPLE_WORLD, tokenPairSchema } from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setMockApi, setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { resetOnboardingForTests, onboardingStore } from '../src/onboarding/store';
import { targetsStore } from '../src/onboarding/targets';
import { resetTourForTests } from '../src/onboarding/tourStore';
import { ThemeProvider } from '../src/theme/ThemeProvider';

export const MOBILE = {
  owner: '9826100012',
  city_staff: '9426067890',
  plant_head: '9826100018',
  supervisor: '9826100014',
} as const;

export const ids = SAMPLE_WORLD.ids;

export interface Ctx {
  mock: MockApi;
  client: QueryClient;
}

export async function setup(opts: { seedOrders?: boolean } = {}): Promise<Ctx> {
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  resetOnboardingForTests();
  resetTourForTests();
  targetsStore.setState({ rects: {}, tick: 0 });
  onboardingStore.setState({ hydrated: true });
  const mock = await createMockApi({
    clock: createFakeClock(Date.UTC(2026, 10, 3, 4, 30)),
    seedOrders: opts.seedOrders ?? false,
  });
  setMockApi(mock);
  setTransport(mock.transport);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity }, mutations: { gcTime: Infinity } },
  });
  return { mock, client };
}

export async function signInAs(mock: MockApi, mobile: string): Promise<void> {
  const deviceId = await useSession.getState().ensureDeviceId();
  await mock.transport.request({ method: 'POST', path: '/v1/auth/request-code', headers: {}, body: { mobile } });
  const res = await mock.transport.request({
    method: 'POST',
    path: '/v1/auth/verify',
    headers: {},
    body: { mobile, code: '123456', deviceId },
  });
  await useSession.getState().signIn(tokenPairSchema.parse(res.body));
}

export function wrap(client: QueryClient, ui: ReactElement) {
  return render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 412, height: 915 },
        insets: { top: 24, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <UnitBasisProvider>{ui}</UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );
}
