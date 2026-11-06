import type { DemoUser, MockControls } from '@tonnage/mock-api';
import { formatMobile } from '@tonnage/shared';
import { useNavigation, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { signInAsDemo } from '../api/demo';
import { useMe } from '../api/hooks/me';
import { useSession } from '../auth/session';
import { ROLE_LABEL, ROLE_SHORT } from '../nav/roles';
import { freshStartOn } from '../nav/freshStart';
import { firstTab } from '../nav/tabs';
import { useTheme } from '../theme/ThemeProvider';
import { Avatar, Badge, Button, Group, Row, SectionLabel, Text } from '../ui';
import { ROLE_TONE } from './admin/parts';
import { messageFor } from './messages';

/**
 * Everyone in the demo data (including people invited or deactivated on this phone), grouped by
 * business. Tapping a person signs in as them without a code and opens their first tab.
 */
export function DemoPeopleList({ controls }: { controls: MockControls }) {
  const router = useRouter();
  const navigation = useNavigation();
  const { t } = useTheme();
  const signedIn = useSession((s) => s.status !== 'signedOut');
  const { data: me } = useMe();
  const [users, setUsers] = useState<DemoUser[] | null>(null);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [message, setMessage] = useState<string | undefined>();
  const [switching, setSwitching] = useState<string | null>(null);
  // State updates land after the next render; a ref stops a fast second tap starting a second switch.
  const busy = useRef(false);
  const live = useRef(true);

  const load = useCallback(() => {
    setLoadError(null);
    controls.listUsers().then(
      (list) => live.current && setUsers(list),
      (e: unknown) => live.current && setLoadError(e),
    );
  }, [controls]);

  useEffect(() => {
    live.current = true;
    load();
    return () => {
      live.current = false;
    };
  }, [load]);

  // Grouped by business id (two businesses may share a name), in the order the mock sorted them.
  const tenants = useMemo(() => {
    const groups = new Map<string, { name: string; people: DemoUser[] }>();
    for (const u of users ?? []) {
      const g = groups.get(u.tenantId) ?? { name: u.tenantName, people: [] };
      g.people.push(u);
      groups.set(u.tenantId, g);
    }
    return [...groups.entries()];
  }, [users]);

  async function switchTo(u: DemoUser) {
    if (busy.current) return;
    busy.current = true;
    setMessage(undefined);
    setSwitching(u.id);
    // From Demo tools the previous person's tabs are still mounted underneath; from the signed-out
    // Sign in as screen they are not, and the signed-in area mounts fresh.
    const fromInsideApp = useSession.getState().status !== 'signedOut';
    try {
      await signInAsDemo(u.id);
      if (fromInsideApp) freshStartOn(navigation, firstTab(u.role));
      else router.replace(`/${firstTab(u.role)}`);
    } catch (e) {
      busy.current = false;
      if (!live.current) return;
      setMessage(messageFor(e));
      setSwitching(null);
    }
  }

  if (loadError !== null && users === null) {
    return (
      <View style={styles.section}>
        <Text color="tx2" accessibilityRole="alert">
          {messageFor(loadError)}
        </Text>
        <Button variant="secondary" onPress={load}>
          Try again
        </Button>
      </View>
    );
  }

  return (
    <>
      {message ? (
        <Text color="dgt" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
      {users === null ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading people" />
      ) : (
        tenants.map(([tenantId, { name: tenant, people }]) => (
          <View key={tenantId} style={styles.section}>
            <SectionLabel>
              {tenants.length > 1 ? `Sign in as · ${tenant}` : 'Sign in as'}
            </SectionLabel>
            <Group>
              {people.map((u) => {
                const you = signedIn && u.id === me?.id;
                const scope = u.plants.length > 0 ? u.plants.join(', ') : 'All units';
                const status = you ? ', you' : u.active ? '' : ', deactivated';
                return (
                  <Row
                    key={u.id}
                    disabled={you || !u.active || switching !== null}
                    onPress={() => void switchTo(u)}
                    accessibilityLabel={`${u.name}, ${ROLE_LABEL[u.role]}, ${scope}${status}`}
                  >
                    <Avatar name={u.name} tone={u.active ? ROLE_TONE[u.role] : 'nu'} />
                    <View style={styles.fill}>
                      <Text weight="medium" numberOfLines={1}>
                        {u.name}
                      </Text>
                      <Text variant="caption" numberOfLines={1}>
                        {`${scope} · ${formatMobile(u.mobile)}`}
                      </Text>
                    </View>
                    {switching === u.id ? (
                      <ActivityIndicator color={t.br} />
                    ) : you ? (
                      <Badge kind="ok">You</Badge>
                    ) : !u.active ? (
                      <Badge kind="nu">Deactivated</Badge>
                    ) : (
                      <Badge kind={ROLE_TONE[u.role]}>{ROLE_SHORT[u.role]}</Badge>
                    )}
                  </Row>
                );
              })}
            </Group>
          </View>
        ))
      )}
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  section: { gap: 18 },
});
