import { formatMobile, type Role, type User } from '@tonnage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { accessFormSchema, userPatch } from '../../admin/forms';
import { ApiError } from '../../api/client';
import { useCompanies } from '../../api/hooks/companies';
import { useMe } from '../../api/hooks/me';
import { usePlants } from '../../api/hooks/plants';
import { currentIdentity } from '../../api/hooks/cache';
import { USERS_KEY, useSetUserActive, useUpdateUser, useUsers } from '../../api/hooks/users';
import { ROLE_LABEL } from '../../nav/roles';
import { useTheme } from '../../theme/ThemeProvider';
import { Avatar, Badge, Button, EmptyState, Screen, showToast, Text } from '../../ui';
import { MSG, messageFor } from '../messages';
import { useSingleFlight } from '../../api/submitKey';
import { AccessFields, BackHeader, FormMessage, ROLE_TONE } from './parts';

/** An edit in progress, with the record it started from (diffed against and versioned from). */
type Draft = { role: Role; plantIds: string[]; base: User };

/**
 * One person: role and plant access, deactivate / reactivate. Read from the users list cache
 * (ledger R6). Your own account is shown but not editable here, so an owner can never lock
 * themselves out by accident.
 */
export function UserDetailScreen({ id }: { id: string }) {
  const { t } = useTheme();
  const qc = useQueryClient();
  const users = useUsers();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const { data: plants } = usePlants();
  const update = useUpdateUser();
  const setActive = useSetUserActive();
  const [draft, setDraft] = useState<Draft | null>(null);
  const [message, setMessage] = useState<string | undefined>();
  const [plantError, setPlantError] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const once = useSingleFlight();

  const user = users.data?.find((u) => u.id === id);

  if (!user) {
    if (users.isPending) {
      return (
        <Screen header={<BackHeader />}>
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        </Screen>
      );
    }
    return (
      <Screen header={<BackHeader />}>
        <EmptyState
          icon="users"
          title="Not found"
          body={users.isError ? messageFor(users.error) : MSG.notFound}
          actions={
            users.isError ? [{ label: 'Try again', onPress: () => void users.refetch() }] : []
          }
        />
      </Screen>
    );
  }

  const self = me?.id === user.id;
  const values = draft ?? { role: user.role, plantIds: user.plantIds };
  const parsed = accessFormSchema.safeParse({ role: values.role, plantIds: values.plantIds });
  // Diff against the version the edit started from: a change saved meanwhile elsewhere must come
  // back as STALE, never be reverted by our older copy of the other fields.
  const patch = parsed.success ? userPatch(draft?.base ?? user, parsed.data) : null;
  const first = user.name.split(/\s+/)[0] ?? user.name;
  const busy = update.isPending || setActive.isPending;

  /** Someone else saved first: drop our edits and show theirs. */
  async function reloadAfterStale() {
    setDraft(null);
    showToast(MSG.stale);
    await qc.refetchQueries({ queryKey: USERS_KEY });
  }

  async function save() {
    setMessage(undefined);
    if (!parsed.success) {
      setPlantError(parsed.error.issues[0]?.message);
      return;
    }
    if (!patch) return;
    const identity = currentIdentity();
    try {
      await update.mutateAsync({ id: user!.id, patch });
      if (currentIdentity() !== identity) return;
      setDraft(null);
      showToast('Saved');
    } catch (e) {
      if (currentIdentity() !== identity) return;
      if (e instanceof ApiError && e.code === 'STALE') await reloadAfterStale();
      else if (e instanceof ApiError && e.code === 'PLANT_RULE') setPlantError(MSG.plantRule);
      else setMessage(messageFor(e));
    }
  }

  async function toggleActive(active: boolean) {
    setMessage(undefined);
    setConfirming(false);
    try {
      await setActive.mutateAsync({ id: user!.id, active });
      showToast(active ? `${first} can sign in again` : `${first} is signed out everywhere`);
    } catch (e) {
      setMessage(messageFor(e));
    }
  }

  const status = !user.active ? 'Inactive' : user.status === 'invited' ? 'Invited' : 'Active';

  return (
    <Screen
      title={user.name}
      keyboard
      header={<BackHeader />}
      footer={
        user.active && !self ? (
          <Button
            onPress={() => void once(save)}
            loading={update.isPending}
            disabled={!draft || !patch || setActive.isPending}
          >
            Save changes
          </Button>
        ) : undefined
      }
    >
      <View style={[styles.card, { backgroundColor: t.card, borderColor: t.bd }]}>
        <Avatar name={user.name} tone={user.active ? ROLE_TONE[user.role] : 'nu'} size={48} />
        <View style={styles.fill}>
          <Text weight="medium">{ROLE_LABEL[user.role]}</Text>
          <Text variant="caption">{formatMobile(user.mobile)}</Text>
        </View>
        <Badge kind={status === 'Active' ? 'ok' : status === 'Invited' ? 'wn' : 'nu'} dot>
          {status}
        </Badge>
      </View>

      {self ? (
        <Text color="tx2">This is you. Ask another owner to change your role or access.</Text>
      ) : null}
      {!user.active ? (
        <Text color="tx2">
          {first} can&apos;t sign in. Reactivate to give back the same role and plants.
        </Text>
      ) : null}

      {user.active ? (
        <AccessFields
          name={user.name}
          role={values.role}
          plantIds={values.plantIds}
          companies={companies}
          plants={plants}
          users={users.data}
          excludeUserId={user.id}
          plantError={plantError}
          locked={self || busy}
          onChange={(next) => {
            setPlantError(undefined);
            setMessage(undefined);
            setDraft((d) => ({ ...next, base: d?.base ?? user }));
          }}
        />
      ) : null}

      <FormMessage>{message}</FormMessage>

      {self ? null : user.active ? (
        confirming ? (
          <View style={[styles.confirm, { backgroundColor: t.dgs }]}>
            <Text>
              {first} will be signed out on every phone and can&apos;t sign in until reactivated.
            </Text>
            <Button
              variant="danger"
              onPress={() => void toggleActive(false)}
              loading={setActive.isPending}
            >
              {`Yes, deactivate ${first}`}
            </Button>
            <Button variant="secondary" onPress={() => setConfirming(false)}>
              Cancel
            </Button>
          </View>
        ) : (
          <Button variant="secondary" onPress={() => setConfirming(true)} disabled={busy}>
            Deactivate
          </Button>
        )
      ) : (
        <Button onPress={() => void toggleActive(true)} loading={setActive.isPending}>
          Reactivate
        </Button>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
  },
  confirm: { borderRadius: 16, padding: 16, gap: 10 },
});
