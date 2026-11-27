import type { Role } from '@tonnage/shared';
import { useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { useMe } from '../../api/hooks/me';
import { type HowTo, howToFor } from '../../onboarding/howTo';
import { onboardingStore, useProgress } from '../../onboarding/store';
import { ROLE_TOUR_NAME, tourSummary } from '../../onboarding/tours';
import { useTour } from '../../onboarding/useTour';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH } from '../../theme/tokens';
import { Group, Icon, IconTile, Row, Screen, SectionLabel, Switch, Text, type Tone, showToast } from '../../ui';
import { BackHeader } from '../admin/parts';
import { HowToSheet } from './HowToSheet';

const ALL_ROLES: Role[] = ['owner', 'city_staff', 'plant_head', 'supervisor'];

const TEAM_LINE: Record<Role, string> = {
  owner: 'orders, trucks, money',
  city_staff: 'orders, vehicles, payments',
  plant_head: 'one plant, orders & dispatch',
  supervisor: 'arrive, tare, product weights',
};

const ROLE_TONE: Record<Role, Tone> = { owner: 'bl', city_staff: 'te', plant_head: 'gr', supervisor: 'am' };

const summary = (role: Role) => `${tourSummary(role).steps} steps`;

/** Board 46: replay the tour, see what the team sees, short answers, and tips on or off. */
export function HelpTourScreen() {
  const { t } = useTheme();
  const { data: me } = useMe();
  const tour = useTour();
  const progress = useProgress();
  const [topic, setTopic] = useState<HowTo | null>(null);

  if (!me) {
    return (
      <Screen title="Help & tour" header={<BackHeader />}>
        {null}
      </Screen>
    );
  }
  // No policy action covers this: the office roles (owner, city staff) brief the plant roles.
  const seesTeam = me.role === 'owner' || me.role === 'city_staff';
  const own = `${ROLE_TOUR_NAME[me.role]} · ${summary(me.role)} · about 1 min`;

  return (
    <Screen title="Help & tour" header={<BackHeader />}>
      <Group>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Replay your tour, ${own}`}
          onPress={tour.startTour}
          style={({ pressed }) => [styles.hero, { backgroundColor: pressed ? t.act : t.card }]}
        >
          <View style={[styles.play, { backgroundColor: t.inv }]}>
            <Icon name="chevronRight" size={22} color={t.invtx} strokeWidth={2.25} />
          </View>
          <View style={styles.fill}>
            <Text weight="semibold" style={styles.heroTitle}>
              Replay your tour
            </Text>
            <Text variant="caption">{own}</Text>
          </View>
        </Pressable>
      </Group>

      {seesTeam ? (
        <>
          <SectionLabel>What your team sees</SectionLabel>
          <Group>
            {ALL_ROLES.filter((r) => r !== me.role).map((r) => (
              <Row
                key={r}
                accessibilityLabel={`${ROLE_TOUR_NAME[r]} tour, ${summary(r)}, ${TEAM_LINE[r]}`}
                onPress={() => tour.startPreview(r)}
              >
                <IconTile icon="user" tone={ROLE_TONE[r]} />
                <View style={styles.fill}>
                  <Text weight="medium">{`${ROLE_TOUR_NAME[r]} tour`}</Text>
                  <Text variant="caption">{`${summary(r)} · ${TEAM_LINE[r]}`}</Text>
                </View>
                <Icon name="chevronRight" size={18} color={t.tx3} />
              </Row>
            ))}
          </Group>
        </>
      ) : null}

      <SectionLabel>How do I…</SectionLabel>
      <Group>
        {howToFor(me.role).map((h) => (
          <Row key={h.id} accessibilityLabel={h.title} onPress={() => setTopic(h)}>
            <Text weight="medium" style={styles.fill}>
              {h.title}
            </Text>
            <Icon name="chevronRight" size={18} color={t.tx3} />
          </Row>
        ))}
      </Group>

      <Group>
        <Row>
          <View style={styles.fill}>
            <Text weight="medium">Show tips on new screens</Text>
            <Text variant="caption">One small tip the first time a screen opens</Text>
          </View>
          <Switch
            label="Show tips on new screens"
            value={progress.tipsOn}
            onChange={(on) => onboardingStore.getState().update(me.id, { tipsOn: on })}
          />
        </Row>
        <Row
          accessibilityLabel="Show all tips again"
          onPress={() => {
            onboardingStore.getState().update(me.id, { tipsSeen: [], tipsOn: true });
            showToast('Tips will show again');
          }}
        >
          <Text weight="medium" color="brt" style={styles.fill}>
            Show all tips again
          </Text>
        </Row>
      </Group>

      <HowToSheet topic={topic} onClose={() => setTopic(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  hero: { flexDirection: 'row', alignItems: 'center', gap: 14, padding: 16, minHeight: MIN_TOUCH + 28 },
  play: { width: 48, height: 48, borderRadius: 16, alignItems: 'center', justifyContent: 'center' },
  heroTitle: { fontSize: 16, lineHeight: 22 },
});
