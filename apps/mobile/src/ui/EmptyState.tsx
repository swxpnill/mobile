import type { ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { Button } from './Button';
import { Icon, type IconName } from './Icon';
import { Text } from './Text';

export interface EmptyStateAction {
  label: string;
  onPress(): void;
}

/** First-run / nothing-here state: icon tile, title, one sentence, then the next steps. */
export function EmptyState({
  icon = 'orders',
  title,
  body,
  actions = [],
  children,
}: {
  icon?: IconName;
  title: string;
  body: string;
  /** The first action is primary, the rest secondary. */
  actions?: EmptyStateAction[];
  children?: ReactNode;
}) {
  const { t } = useTheme();
  return (
    <View style={styles.wrap}>
      <View style={styles.top}>
        <View style={[styles.tile, { backgroundColor: t.brs }]}>
          <Icon name={icon} size={40} strokeWidth={1.5} color={t.brt} />
        </View>
        <Text variant="subtitle" accessibilityRole="header" style={styles.title}>
          {title}
        </Text>
        <Text color="tx2" style={styles.body}>
          {body}
        </Text>
      </View>
      {actions.length > 0 ? (
        <View style={styles.actions}>
          {actions.map((a, i) => (
            <Button key={a.label} variant={i === 0 ? 'primary' : 'secondary'} onPress={a.onPress}>
              {a.label}
            </Button>
          ))}
        </View>
      ) : null}
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: { gap: 20 },
  top: { alignItems: 'center', gap: 12, paddingTop: 32, paddingHorizontal: 12, paddingBottom: 8 },
  tile: { width: 88, height: 88, borderRadius: 28, alignItems: 'center', justifyContent: 'center' },
  title: { marginTop: 8, textAlign: 'center' },
  body: { maxWidth: 300, textAlign: 'center' },
  actions: { gap: 10 },
});
