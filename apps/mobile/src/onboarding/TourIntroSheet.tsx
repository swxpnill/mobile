import { Pressable, StyleSheet, View } from 'react-native';
import { useMe } from '../api/hooks/me';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH } from '../theme/tokens';
import { Button, IconTile, Text } from '../ui';
import { Sheet } from '../ui/Sheet';
import { onboardingStore } from './store';
import { tourStore } from './tourStore';
import { INTRO } from './tours';
import { firstName, useTour } from './useTour';

/** Board 42: on first sign-in, what this role can do, then the tour or not now. */
export function TourIntroSheet() {
  const { t } = useTheme();
  const { data: me } = useMe();
  const tour = useTour();
  const visible = tourStore((s) => s.intro);
  if (!me) return null;
  const intro = INTRO[me.role];
  const name = firstName(me.name);
  const where = me.role === 'supervisor' ? 'Profile' : 'More';

  const skip = () => {
    onboardingStore.getState().update(me.id, { introSeen: true });
    tourStore.getState().setIntro(false);
  };

  return (
    <Sheet
      visible={visible}
      title={`Hi ${name}, ${intro.lead}`}
      onClose={skip}
      header={
        <View style={styles.head}>
          <Text variant="overline" style={{ color: t.brt }}>
            Welcome to Tonnage
          </Text>
          <Text weight="semibold" accessibilityRole="header" style={styles.h}>
            {'Hi '}
            <Text weight="semibold" style={[styles.h, { color: t.brt }]}>
              {name}
            </Text>
            {`, ${intro.lead}`}
          </Text>
        </View>
      }
    >
      <View style={styles.points}>
        {intro.points.map((p) => (
          <View key={p.title} style={styles.point} accessible accessibilityLabel={`${p.title}. ${p.body}`}>
            <IconTile icon={p.icon} tone={p.tone} size={44} />
            <View style={styles.fill}>
              <Text weight="semibold">{p.title}</Text>
              <Text variant="caption" style={styles.pointBody}>
                {p.body}
              </Text>
            </View>
          </View>
        ))}
      </View>
      <View style={styles.actions}>
        <Button onPress={tour.startTour}>Start tour · 1 min</Button>
        <Pressable accessibilityRole="button" accessibilityLabel="Skip for now" onPress={skip} style={styles.ghost}>
          <Text weight="semibold" color="tx2">
            Skip for now
          </Text>
        </Pressable>
        <Text variant="caption" style={styles.center}>
          {`Replay anytime from ${where} → Help & tour`}
        </Text>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  head: { gap: 6 },
  h: { fontSize: 24, lineHeight: 30, letterSpacing: -0.6 },
  points: { gap: 16, marginTop: 4 },
  point: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  fill: { flex: 1, minWidth: 0 },
  pointBody: { fontSize: 13, lineHeight: 18 },
  actions: { gap: 6, marginTop: 4 },
  ghost: { minHeight: MIN_TOUCH + 8, alignItems: 'center', justifyContent: 'center' },
  center: { textAlign: 'center' },
});
