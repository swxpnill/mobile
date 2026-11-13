import { StatusBar } from 'expo-status-bar';
import { Children, Fragment, isValidElement, type ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Pressable,
  ScrollView,
  type StyleProp,
  StyleSheet,
  View,
  type ViewStyle,
  RefreshControl,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH, radius } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

/** A full screen: safe area, background, status bar colour, and (by default) scrolling content. */
export function Screen({
  children,
  title,
  scroll = true,
  header,
  contentStyle,
  keyboard,
  edges = ['top', 'bottom'],
  footer,
  refresh,
}: {
  children: ReactNode;
  /** Large page title; scrolls away with the content, as in the canvas. */
  title?: string;
  scroll?: boolean;
  /** Rendered above the scrolling area (e.g. `<Header onBack>`). */
  header?: ReactNode;
  contentStyle?: StyleProp<ViewStyle>;
  /**
   * Screens with text input: the content shrinks above the on-screen keyboard, so a bottom
   * action ("Verify and continue") stays visible. Android is edge-to-edge from SDK 54, so the
   * window no longer resizes for the keyboard by itself.
   */
  keyboard?: boolean;
  /** Safe-area sides to pad. Tab screens pass `['top']`: the tab bar handles the bottom. */
  edges?: ('top' | 'bottom')[];
  /** Pinned under the scrolling content (e.g. "Send invite"); rides above the keyboard. */
  footer?: ReactNode;
  /** Pull to refresh (scrolling screens only). */
  refresh?: { refreshing: boolean; onRefresh(): void };
}) {
  const { t, scheme } = useTheme();
  // flexGrow lets a `<View style={{ flex: 1 }} />` spacer push a footer to the bottom.
  const body = [styles.content, contentStyle];
  const heading = title ? (
    <Text variant="title" accessibilityRole="header">
      {title}
    </Text>
  ) : null;
  const content = scroll ? (
    <ScrollView
      testID="screen-scroll"
      contentContainerStyle={body}
      keyboardShouldPersistTaps="handled"
      refreshControl={
        refresh ? (
          <RefreshControl refreshing={refresh.refreshing} onRefresh={refresh.onRefresh} tintColor={t.br} colors={[t.br]} />
        ) : undefined
      }
    >
      {heading}
      {children}
    </ScrollView>
  ) : (
    <View style={[styles.fill, body]}>
      {heading}
      {children}
    </View>
  );
  const pinned = footer ? (
    <View style={[styles.footer, { backgroundColor: t.bg, borderTopColor: t.bd }]}>{footer}</View>
  ) : null;
  return (
    <SafeAreaView style={[styles.fill, { backgroundColor: t.bg }]} edges={edges}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      {header}
      {keyboard ? (
        <KeyboardAvoidingView testID="screen-keyboard" behavior="padding" style={styles.fill}>
          {content}
          {pinned}
        </KeyboardAvoidingView>
      ) : (
        <>
          {content}
          {pinned}
        </>
      )}
    </SafeAreaView>
  );
}

/**
 * Top bar above the scrolling content: back button and optional actions on the right. The page
 * title is not here — pass `title` to `Screen` so it scrolls with the content.
 */
export function Header({ onBack, right }: { onBack?: () => void; right?: ReactNode }) {
  const { t } = useTheme();
  if (!onBack && !right) return null;
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
  disabled,
}: {
  children: ReactNode;
  onPress?: () => void;
  accessibilityLabel?: string;
  /** Greyed out and not pressable (e.g. "Coming soon" rows). */
  disabled?: boolean;
}) {
  const { t } = useTheme();
  if (!onPress) {
    // Read-only rows with a label are read as one item by screen readers.
    return (
      <View
        style={[styles.row, disabled ? styles.dim : null]}
        accessible={accessibilityLabel !== undefined}
        accessibilityLabel={accessibilityLabel}
      >
        {children}
      </View>
    );
  }
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        disabled ? styles.dim : null,
        pressed ? { backgroundColor: t.act } : null,
      ]}
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
  dim: { opacity: 0.45 },
  content: { flexGrow: 1, paddingHorizontal: 20, paddingTop: 16, paddingBottom: 32, gap: 18 },
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
  footer: { paddingHorizontal: 20, paddingTop: 12, paddingBottom: 12, borderTopWidth: 1, gap: 10 },
  section: { paddingHorizontal: 4, marginBottom: -10 },
});
