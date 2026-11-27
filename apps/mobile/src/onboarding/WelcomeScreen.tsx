import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Animated, StyleSheet, View } from 'react-native';
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
import { tourStore } from './tourStore';
import { firstName } from './useTour';
import { WELCOME_CAP_MS, WELCOME_FADE_MS, WELCOME_SHOW_MS, roleBadge, welcomeLine } from './welcome';

const ROLE_DOT: Record<string, keyof Tokens> = {
  owner: 'br',
  city_staff: 'te',
  plant_head: 'ok',
  supervisor: 'wn',
};

/**
 * Board 41, "Welcome back": the reopened app greets the person by name with their role and one live
 * line, then fades into the app. Not dismissible by a tap; a tapped notification closes it at once.
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
  const opacity = useRef(new Animated.Value(1)).current;
  // The clock starts when the welcome is actually laid out on screen.
  const [onScreen, setOnScreen] = useState(false);

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
    Animated.timing(opacity, { toValue: 0, duration: WELCOME_FADE_MS, useNativeDriver: true }).start(() =>
      tourStore.getState().hideWelcome(),
    );
  };

  useEffect(() => {
    const cap = setTimeout(() => leave.current(), WELCOME_CAP_MS);
    return () => clearTimeout(cap);
  }, []);

  useEffect(() => {
    if (!onScreen) return;
    const timer = setTimeout(() => leave.current(), WELCOME_SHOW_MS);
    return () => clearTimeout(timer);
  }, [onScreen]);

  const name = me ? firstName(me.name) : '';
  const badge = me ? roleBadge(me.role, me.plantIds, companies, plants) : '';

  return (
    <Animated.View
      testID="welcome"
      onLayout={() => setOnScreen(true)}
      accessible
      accessibilityRole="alert"
      accessibilityLabel={me ? `Welcome back, ${name}. ${badge}. ${line}` : 'Welcome back'}
      style={[StyleSheet.absoluteFill, styles.root, { backgroundColor: t.bg, opacity }]}
    >
      <View style={styles.centre}>
        <View style={[styles.logo, { backgroundColor: t.card, borderColor: t.bd, shadowColor: t.br }]}>
          <Svg width={46} height={46} viewBox="0 0 48 48">
            <Rect x={8} y={9} width={32} height={7} rx={2} fill={unitBarColor(0, scheme)} />
            <Rect x={20.5} y={16} width={7} height={18} fill={unitBarColor(0, scheme)} />
            <Rect x={14} y={34} width={20} height={5} rx={2} fill={unitBarColor(2, scheme)} />
            <Rect x={8} y={9} width={10} height={7} rx={2} fill={unitBarColor(1, scheme)} />
            <Rect x={34} y={9} width={6} height={7} rx={2} fill={unitBarColor(3, scheme)} />
          </Svg>
        </View>
        <Text weight="semibold" style={styles.word}>
          Tonnage
        </Text>
        <Text variant="overline" color="tx3" style={styles.tag}>
          Order · Load · Dispatch
        </Text>
        <View style={styles.seg}>
          {[0, 1, 2, 3].map((i) => (
            <View key={i} style={[styles.segBar, { backgroundColor: unitBarColor(i, scheme) }]} />
          ))}
        </View>

        <View style={styles.greet}>
          <View style={styles.wbRow}>
            <Text variant="overline" style={{ color: t.brt }}>
              Welcome back
            </Text>
            <Icon name="check" size={16} color={t.brt} strokeWidth={2} />
          </View>
          <Text weight="semibold" style={[styles.name, { color: t.brt }]}>
            {name}
          </Text>
        </View>
      </View>

      <View style={styles.bottom}>
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
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  root: { alignItems: 'center', zIndex: 10, elevation: 10 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 40 },
  logo: {
    width: 88,
    height: 88,
    borderRadius: 26,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    shadowOpacity: 0.3,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 8,
  },
  word: { fontSize: 36, lineHeight: 42, letterSpacing: -1.2, marginTop: 20 },
  tag: { marginTop: 6, letterSpacing: 1.8 },
  seg: { flexDirection: 'row', gap: 3, width: 64, height: 4, marginTop: 14 },
  segBar: { flex: 1, borderRadius: 2 },
  greet: { alignItems: 'center', marginTop: 88 },
  wbRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  name: { fontSize: 40, lineHeight: 48, letterSpacing: -1, marginTop: 2 },
  bottom: { alignItems: 'center', gap: 14, paddingBottom: 64, paddingHorizontal: 24 },
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
