import AsyncStorage from '@react-native-async-storage/async-storage';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { getDevicePrefs } from '../src/prefs/device';
import { maskMobile, SignInScreen } from '../src/screens/SignInScreen';
import { VerifyScreen } from '../src/screens/VerifyScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn() };
let mockParams: Record<string, string> = {};
jest.mock('expo-router', () => ({
  useRouter: () => mockRouter,
  useLocalSearchParams: () => mockParams,
}));

let mock: MockApi;
const wrap = (ui: ReactElement) => render(<ThemeProvider>{ui}</ThemeProvider>);

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  mock = await createMockApi({ clock: createFakeClock(Date.UTC(2026, 10, 3, 4, 30)) });
  setTransport(mock.transport);
  mockParams = {};
});

describe('sign-in', () => {
  it('invalid number disables Send code and shows "Enter a 10-digit mobile number"', async () => {
    await wrap(<SignInScreen />);
    const send = screen.getByRole('button', { name: 'Send code' });
    expect(send).toBeDisabled();
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), '12345');
    expect(screen.getByText('Enter a 10-digit mobile number')).toBeOnTheScreen();
    expect(send).toBeDisabled();
  });

  it('a valid number in any shape enables Send code and goes to verify with the normalised number', async () => {
    await wrap(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), '98261 00012');
    const send = screen.getByRole('button', { name: 'Send code' });
    expect(send).toBeEnabled();
    await fireEvent.press(send);
    await waitFor(() =>
      expect(mockRouter.push).toHaveBeenCalledWith({
        pathname: '/verify',
        params: { mobile: '+919826100012' },
      }),
    );
  });

  it('a locked number shows "Too many tries. Try again in 15 minutes."', async () => {
    // Lock the number first through the API.
    const deviceId = '019a4c00-00ff-7000-8000-00000000000a';
    await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/request-code',
      headers: {},
      body: { mobile: '9826100012' },
    });
    for (let i = 0; i < 5; i++) {
      await mock.transport.request({
        method: 'POST',
        path: '/v1/auth/verify',
        headers: {},
        body: { mobile: '9826100012', code: '000000', deviceId },
      });
    }
    await wrap(<SignInScreen />);
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), '9826100012');
    await fireEvent.press(screen.getByRole('button', { name: 'Send code' }));
    expect(await screen.findByText('Too many tries. Try again in 15 minutes.')).toBeOnTheScreen();
    expect(mockRouter.push).not.toHaveBeenCalled();
  });

  it('masks the number like the canvas: +91 98260 ••345', () => {
    expect(maskMobile('+919826012345')).toBe('+91 98260 ••345');
  });
});

describe('verify', () => {
  beforeEach(async () => {
    mockParams = { mobile: '+919826100012' };
    await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/request-code',
      headers: {},
      body: { mobile: '9826100012' },
    });
  });

  it('shows where the code went, the resend countdown and the fingerprint option', async () => {
    await wrap(<VerifyScreen />);
    expect(screen.getByText(/\+91 98261 ••012/)).toBeOnTheScreen();
    expect(screen.getByText('Resend code in 0:30')).toBeOnTheScreen();
    expect(await screen.findByRole('switch', { name: 'Unlock with fingerprint' })).toBeChecked();
  });

  it('OTP_INVALID shows "That code is not right. Try again." and clears the boxes', async () => {
    await wrap(<VerifyScreen />);
    await fireEvent.changeText(screen.getByLabelText('One-time code'), '000000');
    expect(await screen.findByText('That code is not right. Try again.')).toBeOnTheScreen();
    expect(screen.getByLabelText('One-time code')).toHaveDisplayValue('');
    expect(useSession.getState().status).not.toBe('signedIn');
  });

  it('OTP_LOCKED shows "Too many tries. Try again in 15 minutes."', async () => {
    await wrap(<VerifyScreen />);
    const input = screen.getByLabelText('One-time code');
    for (let i = 0; i < 5; i++) {
      await fireEvent.changeText(input, '000000');
      await waitFor(() => expect(screen.getByLabelText('One-time code')).toHaveDisplayValue(''));
    }
    expect(await screen.findByText('Too many tries. Try again in 15 minutes.')).toBeOnTheScreen();
  });

  it('the right code signs in, remembers the fingerprint choice and leaves the auth flow', async () => {
    await wrap(<VerifyScreen />);
    await fireEvent.press(await screen.findByRole('switch', { name: 'Unlock with fingerprint' })); // turn it off
    await fireEvent.changeText(screen.getByLabelText('One-time code'), '123456');
    await waitFor(() => expect(useSession.getState().status).toBe('signedIn'));
    expect(mockRouter.replace).toHaveBeenCalledWith('/');
    expect((await getDevicePrefs()).fingerprint).toBe(false);
  });

  it('a number in two company groups asks which one, then signs in to the choice', async () => {
    const other = await mock.fixtures.createTenant('Bansal Metals');
    // Bansal's owner invites Rajesh's number.
    await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/request-code',
      headers: {},
      body: { mobile: other.ownerMobile },
    });
    const owner = await mock.transport.request({
      method: 'POST',
      path: '/v1/auth/verify',
      headers: {},
      body: {
        mobile: other.ownerMobile,
        code: '123456',
        deviceId: '019a4c00-00ff-7000-8000-00000000000b',
      },
    });
    await mock.transport.request({
      method: 'POST',
      path: '/v1/users',
      headers: {
        authorization: `Bearer ${(owner.body as { accessToken: string }).accessToken}`,
        'idempotency-key': 'k1',
      },
      body: { name: 'Rajesh A', mobile: '9826100012', role: 'city_staff', plantIds: [] },
    });

    await wrap(<VerifyScreen />);
    await fireEvent.changeText(screen.getByLabelText('One-time code'), '123456');
    expect(await screen.findByText('Which company group?')).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Bansal Metals' }));
    await waitFor(() => expect(useSession.getState().status).toBe('signedIn'));
  });
});
