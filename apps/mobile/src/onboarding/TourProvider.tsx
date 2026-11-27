import { type ReactNode, useEffect, useRef, useState } from 'react';
import { BackHandler, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../auth/session';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH } from '../theme/tokens';
import { Text } from '../ui';
import { CoachCard } from './CoachCard';
import { placeCard } from './geometry';
import { SpotlightOverlay } from './SpotlightOverlay';
import { onboardingStore, useProgress } from './store';
import { targetsStore } from './targets';
import { overlayOf, tourStore } from './tourStore';
import { takeColdStartWelcome } from './welcome';
import { WelcomeScreen } from './WelcomeScreen';
import { TourIntroSheet } from './TourIntroSheet';
import { TipBubble } from './TipBubble';

const CARD_SIDE = 20;
const CARD_ESTIMATE = 220;

/** Ends the tour and records it, unless it was another role's preview. */
export function finishTour(): void {
  const t = tourStore.getState().end();
  if (t && !t.preview && t.userId) onboardingStore.getState().update(t.userId, { tourDone: true });
}

/**
 * The onboarding layer (canvas 41–46) over everything signed in: welcome, intro, tour and tips,
 * one at a time. In the tree rather than a Modal, so the lock screen still covers it. While an
 * overlay that needs the whole screen is up, the app underneath takes no touches and is hidden
 * from TalkBack. It waits while a sheet is open or the app is locked.
 */
export function TourProvider({ children }: { children: ReactNode }) {
  const status = useSession((s) => s.status);
  const identity = useSession((s) => s.identity);
  const resumed = useSession((s) => s.resumed);
  const progress = useProgress();
  const prevStatus = useRef(status);
  const openSheets = onboardingStore((s) => s.openSheets);
  const overlay = tourStore(overlayOf);
  const paused = status !== 'signedIn' || openSheets > 0;
  const blocking = !paused && (overlay === 'tour' || overlay === 'welcome');

  // A different person (or nobody): whatever was showing belonged to the last one.
  useEffect(() => {
    const s = tourStore.getState();
    s.end();
    s.hideTip();
    s.setIntro(false);
  }, [identity]);

  useEffect(() => {
    if (status === 'signedOut') tourStore.getState().end();
  }, [status]);

  // Board 41: the app reopened with the person still signed in, or they just unlocked it.
  useEffect(() => {
    const was = prevStatus.current;
    prevStatus.current = status;
    if (status !== 'signedIn') return;
    if (was === 'locked' || (resumed && takeColdStartWelcome())) tourStore.getState().showWelcome();
  }, [status, resumed]);

  // Board 42: first sign-in of this person on this phone, once nothing else is showing.
  useEffect(() => {
    if (status !== 'signedIn' || !progress.hydrated || !progress.userId || progress.introSeen) return;
    if (overlay === 'none') tourStore.getState().setIntro(true);
  }, [status, progress.hydrated, progress.userId, progress.introSeen, overlay]);

  return (
    <View style={styles.fill}>
      <View
        style={styles.fill}
        pointerEvents={blocking ? 'none' : 'auto'}
        accessibilityElementsHidden={blocking}
        importantForAccessibility={blocking ? 'no-hide-descendants' : 'auto'}
      >
        {children}
      </View>
      {!paused && overlay === 'tour' ? <TourLayer /> : null}
      {status === 'signedIn' && overlay === 'welcome' ? <WelcomeScreen /> : null}
      {status === 'signedIn' ? <TourIntroSheet /> : null}
      {!paused && overlay === 'tip' ? <TipBubble /> : null}
    </View>
  );
}

function TourLayer() {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const tour = tourStore((s) => s.tour);
  const rects = targetsStore((s) => s.rects);
  const [cardH, setCardH] = useState(CARD_ESTIMATE);

  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      const cur = tourStore.getState().tour;
      if (!cur) return false;
      if (cur.index === 0) finishTour();
      else tourStore.getState().go(cur.index - 1);
      return true;
    });
    return () => sub.remove();
  }, []);

  // Each step: every target measures again (it may have moved since it last reported).
  useEffect(() => {
    targetsStore.getState().bump();
  }, [tour?.index]);

  if (!tour) return null;
  const step = tour.steps[tour.index];
  if (!step) return null;
  const hole = step.target ? (rects[step.target] ?? null) : null;
  const top = placeCard({ w: width, h: height }, hole, cardH);

  return (
    <View style={StyleSheet.absoluteFill}>
      {/* Takes every touch outside the card. */}
      <Pressable
        style={StyleSheet.absoluteFill}
        accessible={false}
        importantForAccessibility="no"
        onPress={() => undefined}
      />
      <SpotlightOverlay hole={hole} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={tour.preview ? 'Close preview' : 'Skip tour'}
        onPress={finishTour}
        style={[styles.skip, { top: insets.top + 12, backgroundColor: t.invsoft }]}
      >
        <Text weight="semibold" style={{ color: t.spotRing, fontSize: 13 }}>
          {tour.preview ? 'Close' : 'Skip tour'}
        </Text>
      </Pressable>
      <View style={[styles.card, { top: top.top }]}>
        <CoachCard
          step={step}
          index={tour.index}
          total={tour.steps.length}
          lastLabel={tour.lastLabel}
          onBack={() => tourStore.getState().go(tour.index - 1)}
          onNext={() =>
            tour.index === tour.steps.length - 1 ? finishTour() : tourStore.getState().go(tour.index + 1)
          }
          onLayoutHeight={setCardH}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  card: { position: 'absolute', left: CARD_SIDE, right: CARD_SIDE },
  skip: {
    position: 'absolute',
    right: 16,
    minHeight: MIN_TOUCH,
    paddingHorizontal: 16,
    borderRadius: 22,
    justifyContent: 'center',
  },
});
