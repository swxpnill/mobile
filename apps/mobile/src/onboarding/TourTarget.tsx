import { type ComponentRef, type ReactNode, useCallback, useEffect, useRef } from 'react';
import { type StyleProp, View, type ViewStyle } from 'react-native';
import { measure } from './measure';
import { targetsStore, useTourTick } from './targets';
import type { TargetId } from './tours';

/**
 * Marks something a tour step or tip can point at. Reports where it is on screen on layout and
 * whenever the tour asks (a new step), and forgets it on unmount. Adds no layout of its own:
 * `style` is passed through for wrappers that must stretch (tab items).
 */
export function TourTarget({
  id,
  style,
  children,
}: {
  id: TargetId;
  style?: StyleProp<ViewStyle>;
  children: ReactNode;
}) {
  const ref = useRef<ComponentRef<typeof View>>(null);
  const tick = useTourTick();

  const report = useCallback(() => {
    measure(ref.current, (x, y, w, h) => {
      if (w > 0 && h > 0) targetsStore.getState().set(id, { x, y, w, h });
      else targetsStore.getState().clear(id);
    });
  }, [id]);

  useEffect(() => {
    report();
  }, [report, tick]);

  useEffect(() => () => targetsStore.getState().clear(id), [id]);

  return (
    <View ref={ref} collapsable={false} style={style} onLayout={report}>
      {children}
    </View>
  );
}
