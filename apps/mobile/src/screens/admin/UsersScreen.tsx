import { formatMobile, ROLES, type User } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { rolePreview, userScopeLine } from '../../admin/forms';
import { useCompanies } from '../../api/hooks/companies';
import { usePlants } from '../../api/hooks/plants';
import { useUsers } from '../../api/hooks/users';
import { ROLE_LABEL, ROLE_SHORT } from '../../nav/roles';
import { useTheme } from '../../theme/ThemeProvider';
import {
  Avatar,
  Badge,
  Button,
  Group,
  IconButton,
  Row,
  Screen,
  SectionLabel,
  SegmentedControl,
  Text,
} from '../../ui';
import { messageFor } from '../messages';
import { BackHeader, PermissionList, ROLE_TONE } from './parts';

const ROLE_ORDER = new Map(ROLES.map((r, i) => [r, i]));
const NBSP_MOBILE = (m: string) => formatMobile(m).replace(/ /g, ' ');

/** Owners first, then by role, then name: the order a manager scans the list in. */
function sortPeople(list: readonly User[]): User[] {
  return [...list].sort(
    (a, b) =>
      (ROLE_ORDER.get(a.role) ?? 0) - (ROLE_ORDER.get(b.role) ?? 0) || a.name.localeCompare(b.name),
  );
}

/** Canvas "Users & roles": People (active, then deactivated) and Roles (what each can do). */
export function UsersScreen() {
  const router = useRouter();
  const { t } = useTheme();
  const users = useUsers();
  const { data: companies } = useCompanies();
  const { data: plants } = usePlants();
  const [tab, setTab] = useState<'people' | 'roles'>('people');

  const [active, inactive] = useMemo(() => {
    const all = sortPeople(users.data ?? []);
    return [all.filter((u) => u.active), all.filter((u) => !u.active)];
  }, [users.data]);

  const row = (u: User) => {
    const scope = userScopeLine(u, companies, plants);
    const line = `${scope} · ${NBSP_MOBILE(u.mobile)}`;
    const invited = u.status === 'invited';
    return (
      <Row
        key={u.id}
        onPress={() => router.push(`/users/${u.id}`)}
        accessibilityLabel={`${u.name}, ${ROLE_LABEL[u.role]}, ${scope}${
          invited ? ', invited, not signed in yet' : ''
        }${u.active ? '' : ', deactivated'}`}
      >
        <Avatar name={u.name} tone={u.active ? ROLE_TONE[u.role] : 'nu'} />
        <View style={styles.fill}>
          <Text weight="medium" numberOfLines={1} color={u.active ? 'tx' : 'tx2'}>
            {u.name}
          </Text>
          <Text variant="caption" numberOfLines={2}>
            {line}
          </Text>
        </View>
        <View style={styles.badges}>
          <Badge kind={u.active ? ROLE_TONE[u.role] : 'nu'}>{ROLE_SHORT[u.role]}</Badge>
          {invited && u.active ? <Badge kind="nu">Invited</Badge> : null}
        </View>
      </Row>
    );
  };

  return (
    <Screen
      title="Users & roles"
      header={
        <BackHeader
          right={
            <IconButton
              icon="plus"
              label="Invite user"
              onPress={() => router.push('/users/invite')}
            />
          }
        />
      }
    >
      <SegmentedControl
        size="full"
        accessibilityLabel="Show"
        value={tab}
        onChange={(v) => setTab(v === 'roles' ? 'roles' : 'people')}
        options={[
          { value: 'people', label: users.data ? `People · ${active.length}` : 'People' },
          { value: 'roles', label: `Roles · ${ROLES.length}` },
        ]}
      />

      {tab === 'roles' ? (
        <View style={styles.roles}>
          {ROLES.map((r) => {
            const p = rolePreview(r, '', []);
            return (
              <View
                key={r}
                style={[styles.roleCard, { backgroundColor: t.card, borderColor: t.bd }]}
              >
                <Text weight="semibold" accessibilityRole="header">
                  {ROLE_LABEL[r]}
                </Text>
                <PermissionList can={p.can} cannot={p.cannot} />
              </View>
            );
          })}
        </View>
      ) : users.isPending ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading people" />
      ) : users.isError ? (
        <View style={styles.error}>
          <Text color="tx2" accessibilityRole="alert">
            {messageFor(users.error)}
          </Text>
          <Button variant="secondary" onPress={() => void users.refetch()}>
            Try again
          </Button>
        </View>
      ) : (
        <>
          <Group>{active.map(row)}</Group>
          {inactive.length > 0 ? (
            <>
              <SectionLabel>Deactivated</SectionLabel>
              <Group>{inactive.map(row)}</Group>
            </>
          ) : null}
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  badges: { alignItems: 'flex-end', gap: 4 },
  roles: { gap: 12 },
  roleCard: { borderRadius: 16, borderWidth: 1, padding: 16, gap: 12 },
  error: { gap: 12 },
});
