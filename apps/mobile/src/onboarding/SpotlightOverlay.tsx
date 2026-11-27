import { StyleSheet, View, useWindowDimensions } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import { useTheme } from '../theme/ThemeProvider';
import { type Rect, spotlightPath } from './geometry';

export const HOLE_PAD = 6;
export const HOLE_RADIUS = 18;

/** Dims the screen except a rounded hole over `hole`, with a light ring around it (canvas 43). */
export function SpotlightOverlay({ hole }: { hole: Rect | null }) {
  const { t } = useTheme();
  const { width, height } = useWindowDimensions();
  const radius = hole ? Math.min(HOLE_RADIUS, (hole.h + HOLE_PAD * 2) / 2) : 0;
  return (
    <View
      style={StyleSheet.absoluteFill}
      pointerEvents="none"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Svg width={width} height={height}>
        <Path
          testID="spot-path"
          d={spotlightPath({ w: width, h: height }, hole, HOLE_PAD, HOLE_RADIUS)}
          fill={t.dim}
          fillRule="evenodd"
        />
      </Svg>
      {hole ? (
        <View
          testID="spot-ring"
          style={[
            styles.ring,
            {
              left: hole.x - HOLE_PAD,
              top: hole.y - HOLE_PAD,
              width: hole.w + HOLE_PAD * 2,
              height: hole.h + HOLE_PAD * 2,
              borderRadius: radius,
              borderColor: t.spotRing,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  ring: { position: 'absolute', borderWidth: 3 },
});
