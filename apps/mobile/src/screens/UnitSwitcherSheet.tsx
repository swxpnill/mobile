import { toDisplayQty } from '@tonnage/shared';
import { Pressable, StyleSheet, View } from 'react-native';
import { byCode, useCompanies, usePlants } from '../api/hooks/companies';
import { useDisplayBasis } from '../api/hooks/me';
import { useHomeFor } from '../api/hooks/orders';
import { useUnitFilter } from '../prefs/unitFilter';
import { useTheme } from '../theme/ThemeProvider';
import { Group, Icon, Text, UnitTag } from '../ui';
import { Sheet } from '../ui/Sheet';

/**
 * Canvas board 29: choose the unit every screen filters to. Rows show each company's pending in
 * the person's unit basis; picking one closes the sheet.
 */
export function UnitSwitcherSheet({ visible, onClose }: { visible: boolean; onClose(): void }) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const { companyId, set } = useUnitFilter();
  const { data: companies } = useCompanies();
  const { data: plants } = usePlants();
  const { data: home } = useHomeFor('all');
  // Colour slots follow the code-sorted list of every company, so an inactive one shifts nothing.
  const all = byCode(companies ?? []);
  const list = all.filter((c) => c.active);
  const pendingOf = (id: string) => home?.perCompany.find((p) => p.companyId === id)?.pendingKg;
  const qty = (kg: number | undefined) =>
    kg === undefined ? '' : ` · ${toDisplayQty(kg, basis, { withUnit: true })} pending`;

  const pick = (id: string) => {
    set(id);
    onClose();
  };

  const row = (id: string, tag: string, slot: number | null, title: string, detail: string) => {
    const checked = companyId === id;
    return (
      <Pressable
        key={id}
        accessibilityRole="radio"
        accessibilityState={{ checked }}
        accessibilityLabel={`${title}. ${detail}`}
        onPress={() => pick(id)}
        style={({ pressed }) => [styles.row, { borderBottomColor: t.bd }, pressed ? { backgroundColor: t.act } : null]}
      >
        {slot === null ? (
          <View style={[styles.allTag, { backgroundColor: t.ctl }]}>
            <Text weight="semibold" style={{ fontSize: 11, color: t.tx2 }}>
              {tag}
            </Text>
          </View>
        ) : (
          <UnitTag code={tag} slot={slot} />
        )}
        <View style={styles.fill}>
          <Text weight="medium" numberOfLines={1}>
            {title}
          </Text>
          <Text variant="caption" numberOfLines={1}>
            {detail}
          </Text>
        </View>
        {checked ? <Icon name="check" size={20} color={t.brt} /> : null}
      </Pressable>
    );
  };

  return (
    <Sheet visible={visible} title="View data for" onClose={onClose}>
      <Text variant="caption" style={styles.sub}>
        Every screen filters to this choice
      </Text>
      <Group>
        {row(
          'all',
          'ALL',
          null,
          'All units',
          `${list.length} ${list.length === 1 ? 'company' : 'companies'}${qty(home?.pendingKg)}`,
        )}
        {list.map((c) => {
          const where = (plants ?? [])
            .filter((p) => p.companyId === c.id && p.active)
            .map((p) => p.name)
            .join(', ');
          return row(c.id, c.code, all.indexOf(c), c.name, `${where || 'No plants yet'}${qty(pendingOf(c.id))}`);
        })}
      </Group>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  sub: { marginTop: -8, marginBottom: 12 },
  row: {
    minHeight: 56,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  allTag: { minHeight: 20, paddingHorizontal: 6, borderRadius: 5, justifyContent: 'center' },
  fill: { flex: 1, minWidth: 0 },
});
