import { type ReactNode, createContext, useContext, useEffect, useRef } from 'react';
import { Animated, Easing, type StyleProp, type ViewStyle } from 'react-native';
import { useReduceMotion } from '../a11y/useReduceMotion';
import { useTheme } from '../theme/ThemeProvider';

const PULSE_MS = 900;
const PULSE_LOW = 0.45;
const PULSE_DELAY_MS = 150;

const Pulse = createContext<Animated.Value | null>(null);

/**
 * Placeholders that stand in for content while it loads. Every block in a group pulses together
 * (one shared value on the native driver), and stays still with the phone's Remove animations on.
 * The group is read as one "Loading" item; its blocks are hidden from TalkBack.
 */
export function SkeletonGroup({
  children,
  testID,
  style,
}: {
  children: ReactNode;
  testID?: string;
  style?: StyleProp<ViewStyle>;
}) {
  const reduceMotion = useReduceMotion();
  const value = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    if (reduceMotion) {
      value.setValue(1);
      return;
    }
    const ease = Easing.inOut(Easing.quad);
    let loop: Animated.CompositeAnimation | undefined;
    // A short wait: a quick load never flickers, and the phone's motion setting is known by then.
    const wait = setTimeout(() => {
      loop = Animated.loop(
        Animated.sequence([
          Animated.timing(value, { toValue: PULSE_LOW, duration: PULSE_MS, easing: ease, useNativeDriver: true }),
          Animated.timing(value, { toValue: 1, duration: PULSE_MS, easing: ease, useNativeDriver: true }),
        ]),
      );
      loop.start();
    }, PULSE_DELAY_MS);
    return () => {
      clearTimeout(wait);
      loop?.stop();
    };
  }, [reduceMotion, value]);

  return (
    <Pulse.Provider value={value}>
      <Animated.View
        testID={testID}
        accessible
        accessibilityRole="progressbar"
        accessibilityLabel="Loading"
        accessibilityState={{ busy: true }}
        style={style}
      >
        {children}
      </Animated.View>
    </Pulse.Provider>
  );
}

/** One grey block of a placeholder, sized like the content it stands for. */
export function Skeleton({
  width,
  height,
  radius = 6,
  style,
}: {
  width: ViewStyle['width'];
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const { t } = useTheme();
  const pulse = useContext(Pulse);
  return (
    <Animated.View
      testID="skeleton-block"
      importantForAccessibility="no-hide-descendants"
      accessibilityElementsHidden
      style={[{ width, height, borderRadius: radius, backgroundColor: t.act, opacity: pulse ?? 1 }, style]}
    />
  );
}
