import { type Me, formatMobile, meSchema } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { api } from '../../src/api/client';
import { useSession } from '../../src/auth/session';
import { messageFor } from '../../src/screens/messages';
import { Badge, Button, Group, Row, Screen, SectionLabel, Text } from '../../src/ui';

const ROLE_LABEL: Record<Me['role'], string> = {
  owner: 'Owner',
  city_staff: 'City staff / Accounts',
  plant_head: 'Plant head',
  supervisor: 'Loading supervisor',
};

/** Placeholder until the role tabs (Task 8): proves the signed-in API chain end to end. */
export default function Home() {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    api('/v1/me', { schema: meSchema })
      .then(setMe)
      .catch((e: unknown) => setError(messageFor(e)));
  }, []);

  return (
    <Screen title="Home">
      {me ? (
        <>
          <SectionLabel>Signed in</SectionLabel>
          <Group>
            <Row>
              <View style={styles.fill}>
                <Text weight="medium">{me.name}</Text>
                <Text variant="caption">{`${me.tenant.name} · ${formatMobile(me.mobile)}`}</Text>
              </View>
              <Badge kind="br">{ROLE_LABEL[me.role]}</Badge>
            </Row>
          </Group>
          <Text color="tx2">Your tabs arrive in the next step (M1 · Task 8).</Text>
        </>
      ) : error ? (
        <Text color="dgt">{error}</Text>
      ) : (
        <Text color="tx2">Loading…</Text>
      )}
      <View style={styles.spacer} />
      <View style={styles.actions}>
        <Button variant="secondary" onPress={() => router.push('/design-kit')}>
          Open design kit
        </Button>
        <Button variant="secondary" onPress={() => void useSession.getState().signOut()}>
          Sign out
        </Button>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  spacer: { flex: 1 },
  actions: { gap: 10 },
});
