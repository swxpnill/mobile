import { type Company, type Plant, type User } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useMemo } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { byCode, useCompanies } from '../../api/hooks/companies';
import { usePlants } from '../../api/hooks/plants';
import { useUsers } from '../../api/hooks/users';
import { useTheme } from '../../theme/ThemeProvider';
import { unitTagColors } from '../../theme/tokens';
import { Badge, Button, EmptyState, IconButton, Screen, Text, UnitTag } from '../../ui';
import { messageFor } from '../messages';
import { BackHeader } from './parts';

/** "Siltara, Raipur · GSTIN 22AAJCA4410K1ZQ" — the card's second line. */
export function companyLine(c: Company, plants: readonly Plant[]): string {
  const where = plants.map((p) => `${p.name}, ${p.location}`).join('; ') || 'No plants yet';
  return `${where} · ${c.gstin ? `GSTIN ${c.gstin}` : 'No GSTIN'}`;
}

/** Active people working at the company's plants (all-unit roles are not counted per unit). */
function staffAt(plantIds: readonly string[], users: readonly User[] | undefined): string {
  if (!users) return '–';
  const n = users.filter((u) => u.active && u.plantIds.some((id) => plantIds.includes(id))).length;
  return n === 0 ? 'None yet' : `${n} ${n === 1 ? 'person' : 'people'}`;
}

/** Canvas "Companies & units": one card per company, coloured by its unit slot. */
export function CompaniesScreen() {
  const router = useRouter();
  const { t, scheme } = useTheme();
  const companies = useCompanies();
  const { data: plants } = usePlants();
  const { data: users } = useUsers();
  const list = useMemo(() => byCode(companies.data ?? []), [companies.data]);

  const add = () => router.push('/companies/new');

  return (
    <Screen
      title="Companies & units"
      header={<BackHeader right={<IconButton icon="plus" label="Add company" onPress={add} />} />}
    >
      <Text variant="caption" style={styles.sub}>
        Each company has its own GSTIN and bills separately in Tally
      </Text>
      {companies.isPending ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading companies" />
      ) : companies.isError ? (
        <View style={styles.gap}>
          <Text color="tx2" accessibilityRole="alert">
            {messageFor(companies.error)}
          </Text>
          <Button variant="secondary" onPress={() => void companies.refetch()}>
            Try again
          </Button>
        </View>
      ) : list.length === 0 ? (
        <EmptyState
          icon="factory"
          title="Add your first company"
          body="Each company has its own GSTIN, order prefix and plants."
          actions={[{ label: 'Add company', onPress: add }]}
        />
      ) : (
        list.map((c, slot) => {
          const own = (plants ?? []).filter((p) => p.companyId === c.id);
          const stripe = unitTagColors(slot, scheme).fg;
          return (
            <Pressable
              key={c.id}
              accessibilityRole="button"
              accessibilityLabel={`${c.code}, ${c.name}, ${c.active ? 'Active' : 'Inactive'}`}
              onPress={() => router.push(`/companies/${c.id}`)}
              style={({ pressed }) => [
                styles.card,
                { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd },
                c.active ? null : styles.dim,
              ]}
            >
              <View style={[styles.stripe, { backgroundColor: stripe }]} />
              <View style={styles.head}>
                <UnitTag code={c.code} slot={slot} />
                <Text weight="semibold" style={styles.fill} numberOfLines={1}>
                  {c.name}
                </Text>
                <Badge kind={c.active ? 'ok' : 'nu'} dot>
                  {c.active ? 'Active' : 'Inactive'}
                </Badge>
              </View>
              <Text variant="caption">{companyLine(c, own)}</Text>
              <View style={styles.kv}>
                <KV k="Plants" v={String(own.length)} />
                <KV
                  k="Staff"
                  v={staffAt(
                    own.map((p) => p.id),
                    users,
                  )}
                />
                <KV k="Order prefix" v={c.orderPrefix} />
              </View>
            </Pressable>
          );
        })
      )}
    </Screen>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <View style={styles.cell}>
      <Text variant="caption">{k}</Text>
      <Text weight="medium" numberOfLines={1}>
        {v}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  gap: { gap: 12 },
  sub: { marginTop: -12, fontSize: 13 },
  dim: { opacity: 0.6 },
  card: {
    borderRadius: 16,
    borderWidth: 1,
    paddingVertical: 14,
    paddingHorizontal: 16,
    gap: 10,
    overflow: 'hidden',
  },
  stripe: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 4 },
  head: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  kv: { flexDirection: 'row', gap: 8 },
  cell: { flex: 1, minWidth: 0 },
});
