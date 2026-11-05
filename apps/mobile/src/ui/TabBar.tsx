import { Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { TAB_META, type TabKey } from '../nav/tabs';
import { useTheme } from '../theme/ThemeProvider';
import { SMALL_TEXT_MAX_SCALE } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

/**
 * Canvas bottom bar: 80 high (+ the system gesture area), pill behind the active icon, and a
 * filled square-ish "New" button.
 */
export function TabBar({
  tabs,
  active,
  onPress,
}: {
  tabs: TabKey[];
  active: TabKey | undefined;
  onPress(tab: TabKey): void;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  return (
    <View
      accessibilityRole="tablist"
      style={[
        styles.bar,
        { backgroundColor: t.card, borderTopColor: t.bd, paddingBottom: 14 + insets.bottom },
      ]}
    >
      {tabs.map((key) => {
        const meta = TAB_META[key];
        const selected = key === active;
        const isNew = key === 'new';
        const fg = isNew ? t.invtx : selected ? t.brt : t.tx3;
        return (
          <Pressable
            key={key}
            accessibilityRole="tab"
            accessibilityLabel={meta.label}
            accessibilityState={{ selected }}
            onPress={() => onPress(key)}
            style={styles.item}
          >
            <View style={styles.pill}>
              {/*
                The highlight is its own view, mounted when the tab becomes active. Changing the
                background of an existing view on Android (RN 0.88) left its corners square;
                a freshly created view always gets its border radius.
              */}
              {isNew || selected ? (
                <View
                  key={isNew ? 'new' : 'active'}
                  style={[
                    styles.highlight,
                    { backgroundColor: isNew ? t.inv : t.brs, borderRadius: isNew ? 12 : 16 },
                  ]}
                />
              ) : null}
              <Icon name={meta.icon} color={fg} strokeWidth={isNew ? 2 : 1.75} />
            </View>
            <Text
              weight="medium"
              maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}
              numberOfLines={1}
              style={{ fontSize: 12, lineHeight: 16, color: selected ? t.brt : t.tx3 }}
            >
              {meta.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: { flexDirection: 'row', borderTopWidth: 1, paddingTop: 10, paddingHorizontal: 4 },
  item: { flex: 1, alignItems: 'center', gap: 4, minHeight: 56 },
  pill: { width: 56, height: 32, alignItems: 'center', justifyContent: 'center' },
  highlight: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
});
