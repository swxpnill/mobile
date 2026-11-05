import type { DemoUser, MockControls } from '@tonnage/mock-api';
import { formatMobile } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { signInAsDemo } from '../api/demo';
import { useMe } from '../api/hooks/me';
import { useSession } from '../auth/session';
import { ROLE_LABEL, ROLE_SHORT } from '../nav/roles';
import { firstTab } from '../nav/tabs';
import { useTheme } from '../theme/ThemeProvider';
import { Avatar, Badge, Group, Row, SectionLabel, Text } from '../ui';
import { ROLE_TONE } from './admin/parts';
import { messageFor } from './messages';

/**
 * Everyone in the demo data (including people invited or deactivated on this phone), grouped by
 * business. Tapping a person signs in as them without a code and opens their first tab.
 */
export function DemoPeopleList({ controls }: { controls: MockControls }) {
  const router = useRouter();
  const { t } = useTheme();
  const signedIn = useSession((s) => s.status !== 'signedOut');
  const { data: me } = useMe();
  const [users, setUsers] = useState<DemoUser[] | null>(null);
  const [message, setMessage] = useState<string | undefined>();
  const [switching, setSwitching] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    controls.listUsers().then(
      (list) => live && setUsers(list),
      (e: unknown) => live && setMessage(messageFor(e)),
    );
    return () => {
      live = false;
    };
  }, [controls]);

  const tenants = useMemo(() => {
    const groups = new Map<string, DemoUser[]>();
    for (const u of users ?? []) groups.set(u.tenantName, [...(groups.get(u.tenantName) ?? []), u]);
    return [...groups.entries()];
  }, [users]);

  async function switchTo(u: DemoUser) {
    if (switching) return;
    setMessage(undefined);
    setSwitching(u.id);
    try {
      await signInAsDemo(u.id);
      router.replace(`/${firstTab(u.role)}`);
    } catch (e) {
      setMessage(messageFor(e));
      setSwitching(null);
    }
  }

  return (
    <>
      {message ? (
        <Text color="dgt" accessibilityRole="alert" accessibilityLiveRegion="polite">
          {message}
        </Text>
      ) : null}
      {users === null ? (
        message ? null : (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading people" />
        )
      ) : (
        tenants.map(([tenant, people]) => (
          <View key={tenant} style={styles.section}>
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
