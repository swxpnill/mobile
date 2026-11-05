import { StatusBar } from 'expo-status-bar';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import {
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH, radius } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

/** A full screen: safe area, background, status bar colour, and (by default) scrolling content. */
export function Screen({
  children,
  scroll = true,
  header,
  contentStyle,
}: {
  children: ReactNode;
  scroll?: boolean;
  /** Rendered above the scrolling area (e.g. `<Header onBack>`). */
  header?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
}) {
  const { t, scheme } = useTheme();
  const body = [styles.content, contentStyle];
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: t.bg }]} edges={['top', 'bottom']}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {header}
      {scroll ? (
        <ScrollView contentContainerStyle={body} keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View style={[styles.fill, body]}>{children}</View>
      )}
    </SafeAreaView>
  );
}

/** Back button bar, optional actions on the right, and the screen's large title below it. */
export function Header({
  title,
  onBack,
  right,
}: {
  title?: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View>
      <View style={styles.bar}>
        {onBack ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={onBack}
            style={({ pressed }) => [styles.iconBtn, pressed ? { backgroundColor: t.act } : null]}
          >
            <Icon name="back" color={t.tx2} />
          </Pressable>
        ) : null}
        <View style={styles.fill} />
        {right}
      </View>
      {title ? (
        <Text variant="title" accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
      ) : null}
    </View>
  );
}

/** A rounded card of rows, with a hairline between rows (never after the last). */
export function Group({ children, style }: { children: ReactNode; style?: StyleProp<ViewStyle> }) {
  const { t } = useTheme();
  const items = Children.toArray(children).filter(isValidElement);
  return (
    <View style={[styles.group, { backgroundColor: t.card, borderColor: t.bd }, style]}>
      {items.map((child, i) => (
        <Fragment key={child.key ?? i}>
          {i > 0 ? (
            <View testID="group-divider" style={[styles.divider, { backgroundColor: t.bd }]} />
          ) : null}
          {child}
        </Fragment>
      ))}
    </View>
  );
}

/** One line inside a `Group`. Pressable when `onPress` is given. */
export function Row({
  children,
  onPress,
  accessibilityLabel,
}: {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
}) {
  const { t } = useTheme();
  if (!onPress) return <View style={styles.row}>{children}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => [styles.row, pressed ? { backgroundColor: t.act } : null]}
    >
      {children}
    </Pressable>
  );
}

/** Section label above a Group ("APPEARANCE"). */
export function SectionLabel({ children }: { children: string }) {
  return (
    <Text variant="overline" style={styles.section}>
      {children}
    </Text>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 32, gap: 18 },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    paddingTop: 12,
    paddingHorizontal: 8,
    paddingBottom: 4,
    minHeight: 60,
  },
  iconBtn: {
    width: MIN_TOUCH,
    height: MIN_TOUCH,
    borderRadius: 22,
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: { paddingHorizontal: 20, paddingTop: 4, paddingBottom: 14 },
  group: { borderRadius: radius.group, borderWidth: 1, overflow: 'hidden' },
  divider: { height: 1, marginLeft: 16 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 13,
    paddingHorizontal: 16,
    minHeight: MIN_TOUCH + 6,
  },
  section: { paddingHorizontal: 4, marginBottom: -10 },
});
