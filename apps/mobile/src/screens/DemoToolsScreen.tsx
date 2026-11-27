import type { ControlState, MockControls } from '@tonnage/mock-api';
import { runBackgroundSync } from '../offline/backgroundSync';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import {
  armedKey,
  armFailure,
  FAILURE_CHOICES,
  type FailureKey,
  getMockControls,
  resetDemoData,
  simulateActivity,
} from '../api/demo';
import { type Href, useRouter } from 'expo-router';
import { useMe } from '../api/hooks/me';
import { useTheme } from '../theme/ThemeProvider';
import {
  Button,
  ChoiceRow,
  Group,
  Icon,
  MenuRow,
  Row,
  Screen,
  SectionLabel,
  SegmentedControl,
  Switch,
  Text,
  showToast,
} from '../ui';
import { Sheet } from '../ui/Sheet';
import { BackHeader } from './admin/parts';
import { DemoPeopleList } from './DemoPeopleList';
import { messageFor } from './messages';
import { SignOutGuardSheet } from './supervisor/SignOutGuardSheet';
import { notSent, useSyncStatus } from '../offline/useSync';
import { replayFirstSignIn } from '../onboarding/replay';

const LATENCY_OPTIONS = [
  { value: '0', label: 'Off' },
  { value: '800', label: '0.8 s' },
  { value: '6000', label: '6 s' },
] as const;

/** Mock-only screen to rehearse the app: switch person, bad network, failures, fresh data. */
export function DemoToolsScreen() {
  const { t } = useTheme();
  const [controls, setControls] = useState<MockControls | null>(null);
  const [sim, setSim] = useState<ControlState | null>(null);
  const [message, setMessage] = useState<string | undefined>();
  const [confirmReset, setConfirmReset] = useState(false);
  const [resetting, setResetting] = useState(false);
  // A person switch signs this person out: weights not sent yet get the sign-out guard.
  const pending = useSyncStatus(notSent);
  const [pendingSwitch, setPendingSwitch] = useState<(() => void) | null>(null);
  const [simulating, setSimulating] = useState(false);
  const [bgSyncing, setBgSyncing] = useState(false);
  const router = useRouter();
  const { data: me } = useMe();

  const refresh = useCallback((c: MockControls) => {
    setSim((prev) => {
      const next = c.getState();
      return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
    });
  }, []);

  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setInterval> | undefined;
    void getMockControls().then((c) => {
      if (!live || !c) return;
      setControls(c);
      refresh(c);
      // An armed failure fires on whichever request comes next, possibly from another screen:
      // keep the screen honest about what is still armed.
      timer = setInterval(() => refresh(c), 1000);
    });
    return () => {
      live = false;
      if (timer) clearInterval(timer);
    };
  }, [refresh]);

  if (!controls || !sim) {
    return (
      <Screen title="Demo tools" header={<BackHeader />}>
        <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
      </Screen>
    );
  }
  const c = controls;

  async function simulate() {
    setSimulating(true);
    try {
      showToast(await simulateActivity());
    } catch (e) {
      showToast(messageFor(e));
    } finally {
      setSimulating(false);
    }
  }

  async function backgroundSync() {
    setBgSyncing(true);
    try {
      const r = await runBackgroundSync();
      showToast(r === 'synced' ? 'Background sync done' : r === 'skipped' ? 'Nothing to sync for this role' : 'Background sync failed; it retries later');
    } finally {
      setBgSyncing(false);
    }
  }

  async function reset() {
    setResetting(true);
    try {
      await resetDemoData(); // signs out: the app shell sends this phone to Sign in
    } catch (e) {
      setMessage(messageFor(e));
      setResetting(false);
      setConfirmReset(false);
    }
  }

  return (
    <Screen title="Demo tools" header={<BackHeader />}>
      <View style={[styles.note, { backgroundColor: t.wns }]}>
        <Icon name="info" size={18} color={t.wnt} />
        <Text color="wnt" style={styles.fill}>
          Mock mode only. Everything here changes the demo data on this phone, nothing else.
        </Text>
      </View>

      {message ? (
        <Text color="dgt" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}

      <DemoPeopleList
        controls={c}
        confirmSwitch={pending > 0 ? (go) => setPendingSwitch(() => go) : undefined}
      />
      <SignOutGuardSheet
        visible={pendingSwitch !== null}
        onClose={() => setPendingSwitch(null)}
        onConfirm={() => {
          const go = pendingSwitch;
          setPendingSwitch(null);
          go?.();
        }}
      />

      <SectionLabel>Welcome & tour</SectionLabel>
      <Group>
        <MenuRow
          icon="info"
          tone="bl"
          label="Replay first sign-in"
          value="Welcome, intro, tour, tips"
          onPress={() => {
            if (!me) return;
            replayFirstSignIn(me, { navigate: (href) => router.navigate(href as Href) });
            showToast('First sign-in will show again');
          }}
        />
      </Group>

      <SectionLabel>Network</SectionLabel>
      <Group>
        <Row>
          <View style={styles.fill}>
            <Text weight="medium">Offline</Text>
            <Text variant="caption">Every request fails as if there is no signal</Text>
          </View>
          <Switch
            label="Offline"
            value={sim.offline}
            onChange={(on) => {
              c.setOffline(on);
              refresh(c);
            }}
          />
        </Row>
        <Row>
          <View style={styles.fill}>
            <Text weight="medium">Slow server</Text>
            <Text variant="caption">6 s shows the “Waking server…” banner</Text>
          </View>
          <SegmentedControl
            accessibilityLabel="Slow server"
            value={String(sim.latencyMs) as (typeof LATENCY_OPTIONS)[number]['value']}
            options={LATENCY_OPTIONS}
            onChange={(v) => {
              c.setLatency(Number(v));
              refresh(c);
            }}
          />
        </Row>
      </Group>

      <SectionLabel>Next request fails with</SectionLabel>
      <Group>
        {FAILURE_CHOICES.map((f) => (
          <ChoiceRow
            key={f.key}
            kind="radio"
            title={f.title}
            detail={f.detail}
            checked={armedKey(c) === f.key}
            onPress={() => {
              armFailure(c, f.key as FailureKey);
              refresh(c);
            }}
          />
        ))}
      </Group>
      <Text variant="caption" style={styles.hint}>
        Fires once, then turns itself off.
      </Text>

      <SectionLabel>Notifications</SectionLabel>
      <Button variant="secondary" loading={simulating} onPress={() => void simulate()}>
        Simulate someone else’s action
      </Button>
      <Text variant="caption" style={styles.hint}>
        You are never told about your own actions. This has another person do something real that
        notifies you: a ₹1,000 payment to R.K. Agarwal (owner, city staff) or a truck at your plant
        (plant head, supervisor). Watch for the phone notification.
      </Text>

      <SectionLabel>Background sync</SectionLabel>
      <Button variant="secondary" loading={bgSyncing} onPress={() => void backgroundSync()}>
        Run background sync now
      </Button>
      <Text variant="caption" style={styles.hint}>
        Expo Go does not run the every-15-minutes background task, so this runs the same sync on
        demand. It weighs nothing; it sends what is waiting on this phone and pulls new tasks.
      </Text>

      <SectionLabel>Data</SectionLabel>
      <Button variant="danger" onPress={() => setConfirmReset(true)}>
        Reset demo data
      </Button>

      <Sheet
        visible={confirmReset}
        title="Reset demo data?"
        busy={resetting}
        onClose={() => setConfirmReset(false)}
      >
        <Text color="tx2">
          Companies, plants, people and settings go back to the sample data, and every network
          setting above turns off. Everyone is signed out, including you.
        </Text>
        <Button variant="danger" loading={resetting} onPress={() => void reset()}>
          Reset and sign out
        </Button>
        <Button variant="secondary" disabled={resetting} onPress={() => setConfirmReset(false)}>
          Cancel
        </Button>
      </Sheet>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  note: {
    flexDirection: 'row',
    gap: 10,
    alignItems: 'flex-start',
    borderRadius: 14,
    padding: 14,
  },
  hint: { paddingHorizontal: 4, marginTop: -8 },
});
