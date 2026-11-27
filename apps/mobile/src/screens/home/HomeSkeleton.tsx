import { StyleSheet, View } from 'react-native';
import { Group, Skeleton, SkeletonGroup } from '../../ui';

/**
 * Home while its figures load (design addendum 2026-11-27): the shape of what is coming (pending
 * card with its split bar and legend, the two "today" tiles, three "In plant now" rows) so the
 * screen is there at once and fills in, instead of a spinner on an empty page.
 */
export function HomeSkeleton() {
  return (
    <SkeletonGroup testID="home-skeleton" style={styles.gap}>
      <Group>
        <View style={styles.card}>
          <Skeleton width={128} height={12} />
          <View style={styles.gapSm}>
            <Skeleton width="62%" height={40} radius={8} />
            <Skeleton width="48%" height={12} />
          </View>
          <Skeleton width="100%" height={8} radius={4} />
          <View style={styles.legend}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={styles.legendItem}>
                <Skeleton width={10} height={10} radius={3} />
                <Skeleton width="70%" height={12} />
              </View>
            ))}
          </View>
        </View>
      </Group>

      <View style={styles.tiles}>
        {[0, 1].map((i) => (
          <View key={i} style={styles.tileWrap}>
            <Group>
              <View style={styles.tile}>
                <Skeleton width="60%" height={12} />
                <Skeleton width="72%" height={24} radius={6} />
                <Skeleton width="40%" height={12} />
              </View>
            </Group>
          </View>
        ))}
      </View>

      <View style={styles.gapSm}>
        <Skeleton width={132} height={18} radius={6} />
        <Group>
          {[0, 1, 2].map((i) => (
            <View key={i} style={styles.row}>
              <Skeleton width={40} height={40} radius={12} />
              <View style={[styles.fill, styles.gapXs]}>
                <Skeleton width="58%" height={14} />
                <Skeleton width="36%" height={12} />
              </View>
              <Skeleton width={84} height={22} radius={6} />
            </View>
          ))}
        </Group>
      </View>
    </SkeletonGroup>
  );
}

const styles = StyleSheet.create({
  gap: { gap: 16 },
  gapSm: { gap: 10 },
  gapXs: { gap: 6 },
  fill: { flex: 1, minWidth: 0 },
  card: { padding: 20, gap: 16 },
  legend: { flexDirection: 'row', flexWrap: 'wrap', rowGap: 10 },
  legendItem: { width: '50%', flexDirection: 'row', alignItems: 'center', gap: 8 },
  tiles: { flexDirection: 'row', gap: 12 },
  tileWrap: { flex: 1 },
  tile: { padding: 16, gap: 8 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
});
