import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  BackHandler,
  Easing,
  type LayoutChangeEvent,
  StyleSheet,
  View,
} from 'react-native';
import Svg, { Rect } from 'react-native-svg';
import { useCompanies } from '../api/hooks/companies';
import { useDisplayBasis, useMe } from '../api/hooks/me';
import { useHome } from '../api/hooks/orders';
import { usePlants } from '../api/hooks/plants';
import { useReduceMotion } from '../a11y/useReduceMotion';
import { useDeviceSnapshot } from '../offline/useDeviceData';
import { useTheme } from '../theme/ThemeProvider';
import { type Tokens, unitBarColor } from '../theme/tokens';
import { Icon, Text } from '../ui';
import { SPLASH_LOGO_DP, releaseSplash } from './splashGate';
import { tourStore } from './tourStore';
import { firstName } from './useTour';
import {
  WELCOME_CAP_MS,
  WELCOME_ENTER_MS,
  WELCOME_FADE_MS,
  WELCOME_SHOW_MS,
  roleBadge,
  welcomeLine,
} from './welcome';

const ROLE_DOT: Record<string, keyof Tokens> = {
  owner: 'br',
  city_staff: 'te',
  plant_head: 'ok',
  supervisor: 'wn',
};

const TILE = 88;
const GLYPH = 46;
/** The glyph starts at the splash's size and shrinks into its tile. */
const GLYPH_FROM = SPLASH_LOGO_DP / GLYPH;
const RISE = 10;
const LOGO_MS = 550;
const TEXT_MS = 320;
/** When each text group starts, after the logo began moving (ms). */
const STAGGER = { word: 260, tag: 340, greet: 440, bottom: 540 } as const;
// The last group ends inside the entrance window.
if (STAGGER.bottom + TEXT_MS > WELCOME_ENTER_MS) throw new Error('welcome entrance longer than WELCOME_ENTER_MS');

/** A group that fades and rises into place. */
function useReveal(start: number) {
  return useRef({ opacity: new Animated.Value(start), y: new Animated.Value(start ? 0 : RISE) }).current;
}

/**
 * Board 41, "Welcome back". Its first frame is the native splash: the "T" glyph alone, at the
 * splash's size, at the screen centre, on the same background. Once that frame is laid out the
 * splash is released, the glyph shrinks into its tile as the logo rises to its place, and the
 * words fade in. It holds 1.5 s after the entrance, then fades into the app. Not dismissible by a
 * tap; a tapped notification closes it at once (`dismissWelcome`). Remove animations: no motion.
 */
export function WelcomeScreen() {
  const { t, scheme } = useTheme();
  const reduceMotion = useReduceMotion();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const { data: plants } = usePlants(me ? me.role !== 'owner' && me.role !== 'city_staff' : false);
  const office = !!me && me.role !== 'supervisor';
  // Supervisors have no Home (no order access): their line comes from the phone's task list.
  const home = useHome(office);
  const snap = useDeviceSnapshot();

  const fade = useRef(new Animated.Value(1)).current;
  const logoY = useRef(new Animated.Value(0)).current;
  const glyphScale = useRef(new Animated.Value(GLYPH_FROM)).current;
  const tileOpacity = useRef(new Animated.Value(0)).current;
  const tileScale = useRef(new Animated.Value(0.86)).current;
  const word = useReveal(0);
  const tag = useReveal(0);
  const greet = useReveal(0);
  const bottom = useReveal(0);

  // Where things are, from layout: the screen height, the centre column's top, the logo slot's top.
  const [frame, setFrame] = useState<{ h?: number; col?: number; slot?: number }>({});
  // Placed once the profile is known too: before it, the name and badge are empty and the column
  // would still move under the logo after its start was worked out.
  const placed = !!me && frame.h !== undefined && frame.col !== undefined && frame.slot !== undefined;
  const started = useRef(false);
  // Timers of the entrance and hold: cleared on unmount only, so a later re-layout (the live line
  // arriving) cannot cancel them.
  const timers = useRef<{ frame?: number; hold?: ReturnType<typeof setTimeout> }>({});

  const data = !me
    ? {}
    : me.role === 'supervisor'
      ? { waiting: snap ? snap.shown.length : undefined }
      : me.role === 'plant_head'
        ? { inPlant: home.data?.inPlant.length }
        : { pendingKg: home.data?.pendingKg };
  const line = me ? welcomeLine(me.role, data, basis) : '';
  const ready = !!me && (office ? !!home.data : snap !== null);

  const leave = useRef(() => undefined as void);
  leave.current = () => {
    if (reduceMotion) return tourStore.getState().hideWelcome();
    Animated.timing(fade, { toValue: 0, duration: WELCOME_FADE_MS, useNativeDriver: true }).start(() =>
      tourStore.getState().hideWelcome(),
    );
  };

  // Back would act on the screen hidden behind the greeting: it waits the greeting out.
  useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  // Safety net: should layout never come, the app is not held behind the greeting.
  useEffect(() => {
    const cap = setTimeout(() => leave.current(), WELCOME_CAP_MS);
    const t = timers.current;
    return () => {
      clearTimeout(cap);
      clearTimeout(t.hold);
      if (t.frame !== undefined) cancelAnimationFrame(t.frame);
      releaseSplash();
    };
  }, []);

  // The entrance, once the first frame (glyph on the splash's spot) is laid out.
  useEffect(() => {
    if (!placed || started.current) return;
    started.current = true;
    if (reduceMotion) {
      logoY.setValue(0);
      [glyphScale, tileOpacity, tileScale, word.opacity, tag.opacity, greet.opacity, bottom.opacity].forEach((v) => v.setValue(1));
      [word.y, tag.y, greet.y, bottom.y].forEach((v) => v.setValue(0));
      releaseSplash();
      timers.current.hold = setTimeout(() => leave.current(), WELCOME_SHOW_MS);
      return;
    }
    // First frame: the logo on the screen centre, where the splash drew the glyph.
    logoY.setValue(frame.h! / 2 - (frame.col! + frame.slot! + TILE / 2));
    // The splash goes once this frame is on screen, not before (no blank frame between them).
    timers.current.frame = requestAnimationFrame(() => {
      releaseSplash();
      const out = Easing.out(Easing.cubic);
      const reveal = (g: { opacity: Animated.Value; y: Animated.Value }, delay: number) =>
        Animated.parallel([
          Animated.timing(g.opacity, { toValue: 1, duration: TEXT_MS, delay, easing: out, useNativeDriver: true }),
          Animated.timing(g.y, { toValue: 0, duration: TEXT_MS, delay, easing: out, useNativeDriver: true }),
        ]);
      Animated.parallel([
        Animated.timing(logoY, { toValue: 0, duration: LOGO_MS, easing: out, useNativeDriver: true }),
        Animated.timing(glyphScale, { toValue: 1, duration: LOGO_MS, easing: out, useNativeDriver: true }),
        Animated.timing(tileOpacity, { toValue: 1, duration: 360, delay: 120, easing: out, useNativeDriver: true }),
        Animated.timing(tileScale, { toValue: 1, duration: LOGO_MS, easing: out, useNativeDriver: true }),
        reveal(word, STAGGER.word),
        reveal(tag, STAGGER.tag),
        reveal(greet, STAGGER.greet),
        reveal(bottom, STAGGER.bottom),
      ]).start();
      // Entrance, then the 1.5 s hold: timed from the start, not from an animation callback (which
      // an interrupted animation may never call).
      timers.current.hold = setTimeout(() => leave.current(), WELCOME_ENTER_MS + WELCOME_SHOW_MS);
    });
  }, [placed, reduceMotion, frame, logoY, glyphScale, tileOpacity, tileScale, word, tag, greet, bottom]);

  const onRoot = (e: LayoutChangeEvent) => {
    const h = e.nativeEvent.layout.height;
    setFrame((f) => (f.h === h ? f : { ...f, h }));
  };
  const onCol = (e: LayoutChangeEvent) => {
    const col = e.nativeEvent.layout.y;
    setFrame((f) => (f.col === col ? f : { ...f, col }));
  };
  const onSlot = (e: LayoutChangeEvent) => {
    const slot = e.nativeEvent.layout.y;
    setFrame((f) => (f.slot === slot ? f : { ...f, slot }));
  };

  const name = me ? firstName(me.name) : '';
  const badge = me ? roleBadge(me.role, me.plantIds, companies, plants) : '';
  const rise = (g: { opacity: Animated.Value; y: Animated.Value }) => ({
    opacity: g.opacity,
    transform: [{ translateY: g.y }],
  });

  return (
    <Animated.View
      testID="welcome"
      onLayout={onRoot}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={me ? `Welcome back, ${name}. ${badge}. ${line}` : 'Welcome back'}
      style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: t.bg, opacity: fade }]}
    >
      <View testID="welcome-centre" onLayout={onCol} style={styles.centre}>
        <View testID="welcome-logo-slot" onLayout={onSlot} style={styles.slot}>
          <Animated.View testID="welcome-logo" style={[styles.logoBox, { transform: [{ translateY: logoY }] }]}>
            <Animated.View
              style={[
                styles.tile,
                {
                  backgroundColor: t.card,
                  borderColor: t.bd,
                  shadowColor: t.br,
                  opacity: tileOpacity,
                  transform: [{ scale: tileScale }],
                },
              ]}
            />
            <Animated.View style={{ transform: [{ scale: glyphScale }] }}>
              <Svg width={GLYPH} height={GLYPH} viewBox="0 0 48 48">
                <Rect x={8} y={9} width={32} height={7} rx={2} fill={unitBarColor(0, scheme)} />
                <Rect x={20.5} y={16} width={7} height={18} fill={unitBarColor(0, scheme)} />
                <Rect x={14} y={34} width={20} height={5} rx={2} fill={unitBarColor(2, scheme)} />
                <Rect x={8} y={9} width={10} height={7} rx={2} fill={unitBarColor(1, scheme)} />
                <Rect x={34} y={9} width={6} height={7} rx={2} fill={unitBarColor(3, scheme)} />
              </Svg>
            </Animated.View>
          </Animated.View>
        </View>

        <Animated.View style={[styles.wordBox, rise(word)]}>
          <Text weight="semibold" style={styles.word}>
            Tonnage
          </Text>
        </Animated.View>
        <Animated.View style={[styles.tagBox, rise(tag)]}>
          <Text variant="overline" color="tx3" style={styles.tag}>
            Order · Load · Dispatch
          </Text>
          <View style={styles.seg}>
            {[0, 1, 2, 3].map((i) => (
              <View key={i} style={[styles.segBar, { backgroundColor: unitBarColor(i, scheme) }]} />
            ))}
          </View>
        </Animated.View>

        <Animated.View style={[styles.greet, rise(greet)]}>
          <View style={styles.wbRow}>
            <Text variant="overline" style={{ color: t.brt }}>
              Welcome back
            </Text>
            <Icon name="check" size={16} color={t.brt} strokeWidth={2} />
          </View>
          <Text testID="welcome-name" weight="semibold" style={[styles.name, { color: t.brt }]}>
            {name}
          </Text>
        </Animated.View>
      </View>

      <Animated.View testID="welcome-bottom" style={[styles.bottom, rise(bottom)]}>
        {badge ? (
          <View style={[styles.role, { backgroundColor: t.card, borderColor: t.bd }]}>
            <View style={[styles.dot, { backgroundColor: t[ROLE_DOT[me?.role ?? 'owner'] ?? 'br'] }]} />
            <Text weight="semibold" style={styles.roleText}>
              {badge}
            </Text>
          </View>
        ) : null}
        {line ? (
          <View style={styles.live}>
            {reduceMotion || ready ? null : <ActivityIndicator size="small" color={t.inv} />}
            <Text color="tx2">{line}</Text>
          </View>
        ) : null}
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', zIndex: 10, elevation: 10 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 40 },
  slot: { width: TILE, height: TILE },
  logoBox: { width: TILE, height: TILE, alignItems: 'center', justifyContent: 'center' },
  tile: {
    ...StyleSheet.absoluteFill,
    borderRadius: 26,
    borderWidth: 1,
    shadowOpacity: 0.3,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  wordBox: { marginTop: 20 },
  word: { fontSize: 36, lineHeight: 42, letterSpacing: -1.2 },
  tagBox: { alignItems: 'center' },
  tag: { marginTop: 6, letterSpacing: 1.8 },
  seg: { flexDirection: 'row', gap: 3, width: 64, height: 4, marginTop: 14 },
  segBar: { flex: 1, borderRadius: 2 },
  greet: { alignItems: 'center', marginTop: 88 },
  wbRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  // Fixed heights: text arriving later never moves the logo above.
  name: { fontSize: 40, lineHeight: 48, minHeight: 48, letterSpacing: -1, marginTop: 2 },
  bottom: { alignItems: 'center', justifyContent: 'flex-end', gap: 14, minHeight: 70, marginBottom: 64, paddingHorizontal: 24 },
  role: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    minHeight: 36,
    paddingHorizontal: 16,
    borderRadius: 18,
    borderWidth: 1,
  },
  dot: { width: 8, height: 8, borderRadius: 4 },
  roleText: { fontSize: 13 },
  live: { flexDirection: 'row', alignItems: 'center', gap: 8 },
});
