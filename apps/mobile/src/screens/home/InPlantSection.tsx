import { type Home, toDisplayQty } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { Pressable, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge, Group, Icon, Row, Text, UnitTag } from '../../ui';
import { TRUCK_STATE_META } from '../dispatch/truckStateMeta';

const SHOWN = 3;

/** Canvas 02 "In plant now": open trucks at the plants in scope; each opens its detail (Ruling 10). */
export function InPlantSection({ trucks, slotOf }: { trucks: Home['inPlant']; slotOf(code: string): number }) {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  if (trucks.length === 0) return null;
  return (
    <View style={styles.wrap}>
      <View style={styles.head}>
        <Text variant="heading" accessibilityRole="header" style={styles.fill}>
          In plant now
        </Text>
        {trucks.length > SHOWN ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`See all ${trucks.length} trucks on Dispatch`}
            onPress={() => router.navigate('/dispatch')}
            style={styles.link}
          >
            <Text weight="medium" color="brt" style={styles.small}>{`See all ${trucks.length}`}</Text>
          </Pressable>
        ) : null}
      </View>
      <Group>
        {trucks.slice(0, SHOWN).map((x) => {
          const meta = TRUCK_STATE_META[x.state];
          const planned = toDisplayQty(x.plannedKg, basis, { withUnit: true });
          return (
            <Row key={x.truckId} onPress={() => router.push(`/trucks/${x.truckId}`)} accessibilityLabel={`${x.vehicleNo}, ${meta.label}, ${x.companyCode}, plan ${planned}`}>
              <View style={[styles.tile, { backgroundColor: t.brs }]}>
                <Icon name="truck" size={20} color={t.brt} />
              </View>
              <View style={styles.fill}>
                <Text weight="medium">{x.vehicleNo}</Text>
                <Text variant="caption" numberOfLines={1}>{`Plan ${planned}`}</Text>
              </View>
              <View style={styles.side}>
                <Badge kind={meta.kind} dot>
                  {meta.label}
                </Badge>
                <UnitTag code={x.companyCode} slot={slotOf(x.companyCode)} />
              </View>
            </Row>
          );
        })}
      </Group>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 10 },
  head: { flexDirection: 'row', alignItems: 'center' },
  fill: { flex: 1, minWidth: 0 },
  link: { minHeight: 44, justifyContent: 'center', paddingHorizontal: 4 },
  small: { fontSize: 13 },
  tile: { width: 40, height: 40, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  side: { alignItems: 'flex-end', gap: 4 },
});
