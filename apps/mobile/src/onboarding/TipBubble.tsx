import { useEffect, useRef, useState } from 'react';
import { Animated, Pressable, StyleSheet, View, useWindowDimensions } from 'react-native';
import { useMe } from '../api/hooks/me';
import { useReduceMotion } from '../a11y/useReduceMotion';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH } from '../theme/tokens';
import { Text } from '../ui';
import { targetsStore } from './targets';
import { tourStore } from './tourStore';
import { tipFor } from './tips';

const W = 300;
const SIDE = 20;
const GAP = 14;
const ARROW = 14;

/**
 * Board 45: a dark bubble pointing at the thing it explains, with a pulsing dot on it. The screen
 * stays usable around it; "Got it" closes it.
 */
export function TipBubble() {
  const { t } = useTheme();
  const reduceMotion = useReduceMotion();
  const { width, height } = useWindowDimensions();
  const { data: me } = useMe();
  const key = tourStore((s) => s.tip);
  const rect = targetsStore((s) => (key ? s.rects[key] : undefined));
  const [bubbleH, setBubbleH] = useState(150);
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (reduceMotion) return;
    const loop = Animated.loop(Animated.timing(pulse, { toValue: 1, duration: 1800, useNativeDriver: true }));
    loop.start();
    return () => loop.stop();
  }, [pulse, reduceMotion]);

  const tip = me && key ? tipFor(me.role, key) : undefined;
  if (!tip || !rect) return null;

  const w = Math.min(W, width - SIDE * 2);
  const cx = rect.x + rect.w / 2;
  const left = Math.max(SIDE, Math.min(cx - w / 2, width - SIDE - w));
  const above = rect.y + rect.h / 2 > height / 2;
  const top = above ? rect.y - GAP - bubbleH : rect.y + rect.h + GAP;
  const arrowLeft = Math.max(16, Math.min(cx - left - ARROW / 2, w - 16 - ARROW));
  const dotTop = above ? rect.y - 5 : rect.y + rect.h - 5;

  return (
    <View style={StyleSheet.absoluteFill} pointerEvents="box-none">
      <View
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={[styles.dotWrap, { left: cx - 5, top: dotTop }]}
      >
        {reduceMotion ? null : (
          <Animated.View
            style={[
              styles.ripple,
              {
                backgroundColor: t.inv,
                opacity: pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0] }),
                transform: [{ scale: pulse.interpolate({ inputRange: [0, 1], outputRange: [1, 3.4] }) }],
              },
            ]}
          />
        )}
        <View style={[styles.dot, { backgroundColor: t.inv }]} />
      </View>
      <View
        testID="tip-bubble"
        accessibilityLiveRegion="polite"
        onLayout={(e) => setBubbleH(e.nativeEvent.layout.height)}
        style={[styles.bubble, { left, top, width: w, backgroundColor: t.tipBg, shadowColor: t.shadow }]}
      >
        <View
          style={[
            styles.arrow,
            { left: arrowLeft, backgroundColor: t.tipBg },
            above ? { bottom: -ARROW / 2 } : { top: -ARROW / 2 },
          ]}
        />
        <View style={[styles.new, { backgroundColor: t.inv }]}>
          <Text weight="semibold" style={[styles.newText, { color: t.invtx }]}>
            NEW
          </Text>
        </View>
        <Text weight="semibold" style={[styles.title, { color: t.tipTx }]}>
          {tip.title}
        </Text>
        <Text style={[styles.body, { color: t.tipTx2 }]}>{tip.body}</Text>
        <View style={styles.foot}>
          <Text variant="caption" style={{ color: t.tipTx2 }}>
            Tip · shown once
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Got it"
            onPress={() => tourStore.getState().hideTip()}
            style={({ pressed }) => [styles.got, { backgroundColor: pressed ? t.invsoft : t.bd2 }]}
          >
            <Text weight="semibold" style={{ color: t.tipTx, fontSize: 13 }}>
              Got it
            </Text>
          </Pressable>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: {
    position: 'absolute',
    borderRadius: 18,
    padding: 16,
    gap: 8,
    shadowOpacity: 0.35,
    shadowRadius: 20,
    shadowOffset: { width: 0, height: 12 },
    elevation: 12,
  },
  arrow: { position: 'absolute', width: ARROW, height: ARROW, borderRadius: 2, transform: [{ rotate: '45deg' }] },
  new: { alignSelf: 'flex-start', height: 22, paddingHorizontal: 8, borderRadius: 6, justifyContent: 'center' },
  newText: { fontSize: 11, letterSpacing: 0.9 },
  title: { fontSize: 15, lineHeight: 20 },
  body: { fontSize: 13, lineHeight: 19 },
  foot: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginTop: 4 },
  got: { minHeight: MIN_TOUCH, minWidth: MIN_TOUCH, paddingHorizontal: 14, borderRadius: 10, justifyContent: 'center' },
  dotWrap: { position: 'absolute', width: 10, height: 10, alignItems: 'center', justifyContent: 'center' },
  dot: { width: 10, height: 10, borderRadius: 5 },
  ripple: { position: 'absolute', width: 10, height: 10, borderRadius: 5 },
});
