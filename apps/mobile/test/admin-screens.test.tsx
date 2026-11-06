import AsyncStorage from '@react-native-async-storage/async-storage';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react-native';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as SecureStore from 'expo-secure-store';
import type { ReactElement } from 'react';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import {
  NetworkError,
  SAMPLE_WORLD,
  type Transport,
  type TransportRequest,
  tokenPairSchema,
} from '@tonnage/shared';
import { createFakeClock, createMockApi, type MockApi } from '@tonnage/mock-api';
import { UnitBasisProvider } from '../src/api/hooks/me';
import { setTransport } from '../src/api/transport';
import { resetSessionForTests, useSession } from '../src/auth/session';
import { CompaniesScreen } from '../src/screens/admin/CompaniesScreen';
import { CompanyFormScreen } from '../src/screens/admin/CompanyFormScreen';
import { InviteScreen } from '../src/screens/admin/InviteScreen';
import { PlantFormScreen } from '../src/screens/admin/PlantFormScreen';
import { UserDetailScreen } from '../src/screens/admin/UserDetailScreen';
import { UsersScreen } from '../src/screens/admin/UsersScreen';
import { SettingsScreen } from '../src/screens/SettingsScreen';
import { ThemeProvider } from '../src/theme/ThemeProvider';
import { ToastHost, hideToast } from '../src/ui/Toast';

const mockRouter = { push: jest.fn(), replace: jest.fn(), back: jest.fn(), canGoBack: () => true };
jest.mock('expo-router', () => {
  const { Text } = jest.requireActual('react-native');
  return {
    useRouter: () => mockRouter,
    Redirect: ({ href }: { href: string }) => <Text testID="redirect">{href}</Text>,
  };
});

const { ids } = SAMPLE_WORLD;
let mock: MockApi;
let client: QueryClient;
let sent: TransportRequest[];
/** When set, the next matching request reaches the server but its answer is "lost". */
let dropAnswerOf: ((r: TransportRequest) => boolean) | null;
/** When set, matching answers are held (a slow network) until `release()`. */
let holdAnswerOf: ((r: TransportRequest) => boolean) | null;
let releaseHeld: () => void = () => undefined;
const release = () => releaseHeld();

async function signInAs(mobile: string) {
  const deviceId = await useSession.getState().ensureDeviceId();
  await mock.transport.request({
    method: 'POST',
    path: '/v1/auth/request-code',
    headers: {},
    body: { mobile },
  });
  const res = await mock.transport.request({
    method: 'POST',
    path: '/v1/auth/verify',
    headers: {},
    body: { mobile, code: '123456', deviceId },
  });
  await useSession.getState().signIn(tokenPairSchema.parse(res.body));
}

/** Calls the API as the signed-in user, behind the screen's back (another phone). */
async function asOtherPhone(req: Omit<TransportRequest, 'headers'>) {
  return mock.transport.request({
    ...req,
    headers: { authorization: `Bearer ${useSession.getState().accessToken}` },
  });
}

const wrap = (ui: ReactElement) =>
  render(
    <SafeAreaProvider
      initialMetrics={{
        frame: { x: 0, y: 0, width: 390, height: 844 },
        insets: { top: 0, left: 0, right: 0, bottom: 0 },
      }}
    >
      <QueryClientProvider client={client}>
        <ThemeProvider>
          <UnitBasisProvider>
            {ui}
            <ToastHost />
          </UnitBasisProvider>
        </ThemeProvider>
      </QueryClientProvider>
    </SafeAreaProvider>,
  );

const writes = (path: string, method = 'POST') =>
  sent.filter((r) => r.method === method && r.path === path);

beforeEach(async () => {
  jest.clearAllMocks();
  await AsyncStorage.clear();
  (SecureStore as unknown as { __reset(): void }).__reset();
  resetSessionForTests();
  mock = await createMockApi({ clock: createFakeClock(Date.UTC(2026, 10, 3, 4, 30)) });
  sent = [];
  dropAnswerOf = null;
  holdAnswerOf = null;
  hideToast();
  const spy: Transport = {
    request: async (req) => {
      sent.push(req);
      const res = await mock.transport.request(req);
      if (holdAnswerOf?.(req)) {
        await new Promise<void>((r) => {
          releaseHeld = r;
        });
      }
      if (dropAnswerOf?.(req)) {
        dropAnswerOf = null;
        throw new NetworkError('connection lost');
      }
      return res;
    },
  };
  setTransport(spy);
  client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: Infinity },
      mutations: { gcTime: Infinity },
    },
  });
});

afterEach(() => client.clear());

// ── Invite ───────────────────────────────────────────────────────────────────────────────────────

describe('Invite user', () => {
  beforeEach(() => signInAs('9826100012'));

  async function fillNameAndMobile(mobile = '99261 44508') {
    await fireEvent.changeText(screen.getByLabelText('Full name'), 'Deepak Kumar');
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), mobile);
  }

  it('choosing Loading supervisor shows a single plant picker; Send invite stays disabled until one plant is chosen', async () => {
    await wrap(<InviteScreen />);
    await fillNameAndMobile();
    expect(screen.queryByText('Plant access')).toBeNull(); // no role yet
    await fireEvent.press(screen.getByRole('radio', { name: /Loading supervisor/ }));
    expect(await screen.findByText('Plant access')).toBeOnTheScreen();
    // Radios (single choice), one per active plant, with the supervisor count.
    const tilda = await screen.findByRole('radio', { name: /Nandan Alloys · Tilda/ });
    expect(screen.getAllByRole('radio', { name: /· (Siltara|Urla|Borai|Tilda)/ })).toHaveLength(4);
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.getByRole('button', { name: 'Send invite' })).toBeDisabled();

    await fireEvent.press(tilda);
    expect(screen.getByRole('button', { name: 'Send invite' })).toBeEnabled();
    // Picking another plant replaces the first: still exactly one.
    await fireEvent.press(screen.getByRole('radio', { name: /Kalinga Rolling · Borai/ }));
    expect(screen.getByRole('radio', { name: /Nandan Alloys · Tilda/ })).not.toBeChecked();
  });

  it('preview shows "✓ See trucks assigned to Nandan · Tilda" after picking Tilda', async () => {
    await wrap(<InviteScreen />);
    await fillNameAndMobile();
    await fireEvent.press(screen.getByRole('radio', { name: /Loading supervisor/ }));
    await fireEvent.press(await screen.findByRole('radio', { name: /Nandan Alloys · Tilda/ }));
    expect(screen.getByText('Deepak will be able to')).toBeOnTheScreen();
    expect(screen.getByLabelText('Can: See trucks assigned to Nandan · Tilda')).toBeOnTheScreen();
    expect(
      screen.getByLabelText('Cannot: See rates, order values or broker money'),
    ).toBeOnTheScreen();
  });

  it('plant head picks several plants with checkboxes', async () => {
    await wrap(<InviteScreen />);
    await fillNameAndMobile();
    await fireEvent.press(screen.getByRole('radio', { name: /Plant head/ }));
    const boxes = await screen.findAllByRole('checkbox');
    expect(boxes).toHaveLength(4);
    await fireEvent.press(screen.getByRole('checkbox', { name: /Aarav Ispat · Siltara/ }));
    await fireEvent.press(screen.getByRole('checkbox', { name: /Nandan Alloys · Tilda/ }));
    expect(
      screen.getByLabelText('Can: See orders and dispatch of Aarav · Siltara and Nandan · Tilda'),
    ).toBeOnTheScreen();
  });

  it('MOBILE_EXISTS renders under the mobile field', async () => {
    await wrap(<InviteScreen />);
    await fillNameAndMobile('98261 00013'); // Priya's number
    await fireEvent.press(screen.getByRole('radio', { name: /City staff/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText('This number already has an account')).toBeOnTheScreen();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('a retry after a lost answer reuses the key: one user, not two', async () => {
    await wrap(<InviteScreen />);
    await fillNameAndMobile();
    await fireEvent.press(screen.getByRole('radio', { name: /City staff/ }));
    dropAnswerOf = (r) => r.method === 'POST' && r.path === '/v1/users';
    await fireEvent.press(screen.getByRole('button', { name: 'Send invite' }));
    expect(await screen.findByText(/Can't reach the server/)).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());

    const posts = writes('/v1/users');
    expect(posts).toHaveLength(2);
    expect(posts[0]!.headers['idempotency-key']).toBe(posts[1]!.headers['idempotency-key']);
    const users = (await asOtherPhone({ method: 'GET', path: '/v1/users' })).body as {
      name: string;
    }[];
    expect(users.filter((u) => u.name === 'Deepak Kumar')).toHaveLength(1);
    expect(
      await screen.findByText('Deepak Kumar can now sign in with +91 99261 44508'),
    ).toBeOnTheScreen();
  });
});

// ── Users list and detail ────────────────────────────────────────────────────────────────────────

describe('Users & roles', () => {
  beforeEach(() => signInAs('9826100012'));

  it('lists people with scope line and role badge, invited shown; Roles tab explains each role', async () => {
    await wrap(<UsersScreen />);
    const ravi = await screen.findByRole('button', { name: /Ravi Verma/ });
    expect(within(ravi).getByText('Aarav · Siltara only · +91 98261 00014')).toBeOnTheScreen();
    expect(within(ravi).getByText('Supervisor')).toBeOnTheScreen(); // short badge in the list
    const rajesh = screen.getByRole('button', { name: /Rajesh Agrawal/ });
    expect(within(rajesh).getByText(/All units · \+91/)).toBeOnTheScreen();
    expect(screen.getAllByText('Invited').length).toBeGreaterThan(0);

    await fireEvent.press(screen.getByRole('radio', { name: /^Roles/ }));
    expect(await screen.findByText('Plant head')).toBeOnTheScreen();
    expect(screen.getByText('Everything, including delete and settings')).toBeOnTheScreen();
  });

  it('detail: change a supervisor to plant head with two plants', async () => {
    await wrap(<UserDetailScreen id={ids.users.ravi} />);
    await fireEvent.press(await screen.findByRole('radio', { name: /Plant head/ }));
    await fireEvent.press(await screen.findByRole('checkbox', { name: /Nandan Alloys · Tilda/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(writes(`/v1/users/${ids.users.ravi}`, 'PATCH')).toHaveLength(1));
    expect(writes(`/v1/users/${ids.users.ravi}`, 'PATCH')[0]!.body).toEqual({
      role: 'plant_head',
      plantIds: [ids.plants.siltara, ids.plants.tilda],
      version: 1,
    });
    expect(await screen.findByText('Saved')).toBeOnTheScreen();
  });

  it('detail: STALE reloads the latest and says so', async () => {
    await wrap(<UserDetailScreen id={ids.users.ravi} />);
    await screen.findByRole('radio', { name: /Plant head/ });
    // Another owner phone changes Ravi meanwhile.
    await asOtherPhone({
      method: 'PATCH',
      path: `/v1/users/${ids.users.ravi}`,
      body: { plantIds: [ids.plants.urla], version: 1 },
    });
    await fireEvent.press(screen.getByRole('radio', { name: /Plant head/ }));
    await fireEvent.press(await screen.findByRole('checkbox', { name: /Nandan Alloys · Tilda/ }));
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Someone else changed this. Showing the latest.'),
    ).toBeOnTheScreen();
    // The form now shows the other phone's change (Urla), as a supervisor again.
    await waitFor(() =>
      expect(screen.getByRole('radio', { name: /Vrinda Steels · Urla/ })).toBeChecked(),
    );
  });

  it('detail: deactivate asks first, then shows Inactive and Reactivate', async () => {
    await wrap(<UserDetailScreen id={ids.users.ravi} />);
    await fireEvent.press(await screen.findByRole('button', { name: 'Deactivate' }));
    // Confirmation step in the screen (no system dialog).
    await fireEvent.press(await screen.findByRole('button', { name: 'Yes, deactivate Ravi' }));
    expect(await screen.findByRole('button', { name: 'Reactivate' })).toBeOnTheScreen();
    expect(screen.getByText('Inactive')).toBeOnTheScreen();
  });

  it('detail: your own account cannot be deactivated or have its role changed here', async () => {
    await wrap(<UserDetailScreen id={ids.users.rajesh} />);
    expect(await screen.findByText(/This is you/)).toBeOnTheScreen();
    expect(screen.queryByRole('button', { name: 'Deactivate' })).toBeNull();
    expect(screen.getByRole('radio', { name: /City staff/ })).toBeDisabled();
  });
});

// ── Companies ────────────────────────────────────────────────────────────────────────────────────

describe('Companies & units', () => {
  beforeEach(() => signInAs('9826100012'));

  it('lists each company with code, Active, plants and GSTIN, order prefix and staff', async () => {
    await wrap(<CompaniesScreen />);
    const aip = await screen.findByRole('button', { name: /Aarav Ispat Pvt Ltd/ });
    expect(within(aip).getByText('Siltara, Raipur · GSTIN 22AAJCA4410K1ZQ')).toBeOnTheScreen();
    expect(within(aip).getByText('Active')).toBeOnTheScreen();
    expect(within(aip).getByText('SO-AIP')).toBeOnTheScreen();
    await fireEvent.press(aip);
    expect(mockRouter.push).toHaveBeenCalledWith(`/companies/${ids.companies.AIP}`);
  });

  it('invalid GSTIN shows "Enter a valid 15-character GSTIN" and nothing is sent', async () => {
    await wrap(<CompanyFormScreen id="new" />);
    await fireEvent.changeText(screen.getByLabelText('Code'), 'BSP');
    await fireEvent.changeText(screen.getByLabelText('Company name'), 'Bhilai Steel Products');
    await fireEvent.changeText(screen.getByLabelText('GSTIN'), '22AAB');
    await fireEvent.press(screen.getByRole('button', { name: 'Add company' }));
    expect(await screen.findByText('Enter a valid 15-character GSTIN')).toBeOnTheScreen();
    expect(writes('/v1/companies')).toHaveLength(0);
  });

  it('new company: prefix follows the code until edited; saves once and goes back', async () => {
    await wrap(<CompanyFormScreen id="new" />);
    await fireEvent.changeText(screen.getByLabelText('Code'), 'bsp');
    expect(screen.getByLabelText('Order number prefix').props.value).toBe('SO-BSP');
    await fireEvent.changeText(screen.getByLabelText('Company name'), 'Bhilai Steel Products');
    await fireEvent.press(screen.getByRole('button', { name: 'Add company' }));
    await waitFor(() => expect(mockRouter.back).toHaveBeenCalled());
    expect(writes('/v1/companies')[0]!.body).toEqual({
      code: 'BSP',
      name: 'Bhilai Steel Products',
      gstin: null,
      orderPrefix: 'SO-BSP',
    });
  });

  it('duplicate code shows the server message under Code', async () => {
    await wrap(<CompanyFormScreen id="new" />);
    await fireEvent.changeText(screen.getByLabelText('Code'), 'AIP');
    await fireEvent.changeText(screen.getByLabelText('Company name'), 'Another');
    await fireEvent.press(screen.getByRole('button', { name: 'Add company' }));
    expect(
      await screen.findByText('This code is already used by another company'),
    ).toBeOnTheScreen();
  });

  it('edit: STALE shows the toast and the latest values', async () => {
    await wrap(<CompanyFormScreen id={ids.companies.KRM} />);
    const name = await screen.findByLabelText('Company name');
    await waitFor(() => expect(name.props.value).toBe('Kalinga Rolling Mills'));
    await asOtherPhone({
      method: 'PATCH',
      path: `/v1/companies/${ids.companies.KRM}`,
      body: { name: 'Kalinga Rolling Mills Ltd', version: 1 },
    });
    await fireEvent.changeText(name, 'Kalinga Steel');
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Someone else changed this. Showing the latest.'),
    ).toBeOnTheScreen();
    await waitFor(() =>
      expect(screen.getByLabelText('Company name').props.value).toBe('Kalinga Rolling Mills Ltd'),
    );
  });

  it('edit: lists the company plants and adds one', async () => {
    await wrap(<CompanyFormScreen id={ids.companies.KRM} />);
    expect(await screen.findByRole('button', { name: /Borai, Durg/ })).toBeOnTheScreen();
    await fireEvent.press(screen.getByRole('button', { name: 'Add plant' }));
    expect(mockRouter.push).toHaveBeenCalledWith({
      pathname: '/companies/plant',
      params: { companyId: ids.companies.KRM },
    });
  });
});

// ── Settings ─────────────────────────────────────────────────────────────────────────────────────

describe('Settings', () => {
  it('tolerance shows "1.000" with MT and "1,000" with kg; entering 0.5 in MT saves 500 kg', async () => {
    await signInAs('9826100012');
    await wrap(<SettingsScreen />);
    const field = await screen.findByLabelText('Completion tolerance (MT)');
    await waitFor(() => expect(field.props.value).toBe('1.000'));

    await fireEvent.changeText(field, '0.5');
    await fireEvent(field, 'blur');
    await waitFor(() => expect(writes('/v1/settings', 'PATCH')).toHaveLength(1));
    expect(writes('/v1/settings', 'PATCH')[0]!.body).toEqual({ completionToleranceKg: 500 });

    await fireEvent.press(screen.getByRole('radio', { name: 'kg / ₹ per kg' }));
    await waitFor(() =>
      expect(screen.getByLabelText('Completion tolerance (kg)').props.value).toBe('500'),
    );
  });

  it('tolerance field rejects 4 decimals in MT without saving', async () => {
    await signInAs('9826100012');
    await wrap(<SettingsScreen />);
    const field = await screen.findByLabelText('Completion tolerance (MT)');
    await waitFor(() => expect(field.props.value).toBe('1.000'));
    await fireEvent.changeText(field, '0.0005');
    await fireEvent(field, 'blur');
    expect(await screen.findByText('Up to 3 decimals in MT')).toBeOnTheScreen();
    expect(writes('/v1/settings', 'PATCH')).toHaveLength(0);
  });

  it('city staff does not see Orders & dispatch; everyone sees Appearance and Units', async () => {
    await signInAs('9826100013');
    await wrap(<SettingsScreen />);
    expect(await screen.findByText('Appearance')).toBeOnTheScreen();
    expect(screen.getByRole('radio', { name: 'MT / ₹ per MT' })).toBeOnTheScreen();
    expect(screen.queryByText('Orders & dispatch')).toBeNull();
    expect(screen.queryByLabelText(/Completion tolerance/)).toBeNull();
    expect(screen.getByText(/Tonnage v\d+\.\d+\.\d+ · /)).toBeOnTheScreen();
  });
});

// ── Review fixes (Task 9 review) ─────────────────────────────────────────────────────────────────

describe('Task 9 review fixes', () => {
  beforeEach(() => signInAs('9826100012'));

  /** A background refetch (app back in foreground, 30 s stale time) that the screen renders. */
  const refetchAndSettle = (key: string[]) =>
    act(async () => {
      await client.refetchQueries({ queryKey: key });
      await new Promise((r) => setTimeout(r, 20));
    });

  const otherPhoneChange = (path: string, body: object) =>
    asOtherPhone({ method: 'PATCH', path, body });

  async function fillInvite(mobile = '99261 44508') {
    await fireEvent.changeText(screen.getByLabelText('Full name'), 'Deepak Kumar');
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), mobile);
    await fireEvent.press(screen.getByRole('radio', { name: /City staff/ }));
  }

  it('C1 company: a background refetch mid-edit does not turn STALE into a silent overwrite', async () => {
    await wrap(<CompanyFormScreen id={ids.companies.KRM} />);
    const name = await screen.findByLabelText('Company name');
    await waitFor(() => expect(name.props.value).toBe('Kalinga Rolling Mills'));
    await fireEvent.changeText(name, 'Kalinga Steel');
    await otherPhoneChange(`/v1/companies/${ids.companies.KRM}`, {
      orderPrefix: 'KRM-',
      version: 1,
    });
    await refetchAndSettle(['companies']);
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Someone else changed this. Showing the latest.'),
    ).toBeOnTheScreen();
    const krm = (await asOtherPhone({ method: 'GET', path: `/v1/companies/${ids.companies.KRM}` }))
      .body as { orderPrefix: string; name: string };
    expect(krm).toMatchObject({ orderPrefix: 'KRM-', name: 'Kalinga Rolling Mills' });
  });

  it('C1 plant: after a refetch, saving never sends the old location back', async () => {
    await wrap(<PlantFormScreen companyId={ids.companies.KRM} id={ids.plants.borai} />);
    const loc = await screen.findByLabelText('Town or city');
    await waitFor(() => expect(loc.props.value).toBe('Durg'));
    await fireEvent.changeText(screen.getByLabelText('Plant name'), 'Borai 2');
    await otherPhoneChange(`/v1/plants/${ids.plants.borai}`, { location: 'Bhilai', version: 1 });
    await refetchAndSettle(['plants']);
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Someone else changed this. Showing the latest.'),
    ).toBeOnTheScreen();
    const borai = (await asOtherPhone({ method: 'GET', path: `/v1/plants/${ids.plants.borai}` }))
      .body as { location: string; name: string };
    expect(borai).toMatchObject({ location: 'Bhilai', name: 'Borai' });
  });

  it('C1 user: a draft held across a refetch gets STALE, not a revert of the other change', async () => {
    await wrap(<UserDetailScreen id={ids.users.kiran} />);
    await fireEvent.press(await screen.findByRole('checkbox', { name: /Nandan Alloys · Tilda/ }));
    await otherPhoneChange(`/v1/users/${ids.users.kiran}`, {
      plantIds: [ids.plants.siltara, ids.plants.urla],
      version: 1,
    });
    await refetchAndSettle(['users']);
    await fireEvent.press(screen.getByRole('button', { name: 'Save changes' }));
    expect(
      await screen.findByText('Someone else changed this. Showing the latest.'),
    ).toBeOnTheScreen();
    const users = (await asOtherPhone({ method: 'GET', path: '/v1/users' })).body as {
      id: string;
      plantIds: string[];
    }[];
    expect(users.find((u) => u.id === ids.users.kiran)!.plantIds).toEqual([
      ids.plants.siltara,
      ids.plants.urla,
    ]);
  });

  it('I2 invite: a corrected retry after a lost answer says the first try went through and opens it', async () => {
    await wrap(<InviteScreen />);
    await fillInvite();
    dropAnswerOf = (r) => r.method === 'POST' && r.path === '/v1/users';
    await fireEvent.press(screen.getByRole('button', { name: 'Send invite' }));
    await screen.findByText(/Can't reach the server/);
    await fireEvent.changeText(screen.getByLabelText('Mobile number'), '99261 44509');
    await fireEvent.press(screen.getByRole('button', { name: 'Send invite' }));
    expect(
      await screen.findByText(
        'Your first try went through as Deepak Kumar, +91 99261 44508. Check the details.',
      ),
    ).toBeOnTheScreen();
    expect(mockRouter.replace).toHaveBeenCalledWith(expect.stringMatching(/^\/users\/[0-9a-f-]+$/));
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('I5: an answer that lands after sign-out neither toasts nor navigates', async () => {
    await wrap(<InviteScreen />);
    await fillInvite();
    holdAnswerOf = (r) => r.method === 'POST' && r.path === '/v1/users';
    await fireEvent.press(screen.getByRole('button', { name: 'Send invite' }));
    await waitFor(() => expect(writes('/v1/users')).toHaveLength(1));
    await act(() => useSession.getState().signOut());
    await act(async () => release());
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByTestId('toast')).toBeNull();
    expect(mockRouter.back).not.toHaveBeenCalled();
  });

  it('I3: switching units mid-edit never saves the typed number in the new unit', async () => {
    await wrap(<SettingsScreen />);
    const field = await screen.findByLabelText('Completion tolerance (MT)');
    await waitFor(() => expect(field.props.value).toBe('1.000'));
    await fireEvent(field, 'focus');
    await fireEvent.changeText(field, '2');
    await fireEvent.press(screen.getByRole('radio', { name: 'kg / ₹ per kg' }));
    const kg = await screen.findByLabelText('Completion tolerance (kg)');
    await fireEvent(kg, 'blur');
    await new Promise((r) => setTimeout(r, 50));
    expect(writes('/v1/settings', 'PATCH')).toHaveLength(0);
    expect(screen.getByLabelText('Completion tolerance (kg)').props.value).toBe('1,000');
  });

  it('I4: the typed value stays while saving, and Done then blur save once', async () => {
    await wrap(<SettingsScreen />);
    const field = await screen.findByLabelText('Completion tolerance (MT)');
    await waitFor(() => expect(field.props.value).toBe('1.000'));
    holdAnswerOf = (r) => r.method === 'PATCH' && r.path === '/v1/settings';
    await fireEvent(field, 'focus');
    await fireEvent.changeText(field, '0.5');
    await fireEvent(field, 'submitEditing');
    await fireEvent(field, 'blur');
    await waitFor(() => expect(writes('/v1/settings', 'PATCH')).toHaveLength(1));
    expect(screen.getByLabelText('Completion tolerance (MT)').props.value).toBe('0.5');
    await act(async () => release());
    await waitFor(() =>
      expect(screen.getByLabelText('Completion tolerance (MT)').props.value).toBe('0.500'),
    );
    expect(writes('/v1/settings', 'PATCH')).toHaveLength(1);
  });

  it('M9: tolerance above 100 MT is refused without saving', async () => {
    await wrap(<SettingsScreen />);
    const field = await screen.findByLabelText('Completion tolerance (MT)');
    await waitFor(() => expect(field.props.value).toBe('1.000'));
    await fireEvent.changeText(field, '9999999');
    await fireEvent(field, 'blur');
    expect(await screen.findByText('Keep it within 100 MT')).toBeOnTheScreen();
    expect(writes('/v1/settings', 'PATCH')).toHaveLength(0);
  });
});
