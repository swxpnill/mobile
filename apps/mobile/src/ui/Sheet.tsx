import type { ReactNode } from 'react';
import { Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTheme } from '../theme/ThemeProvider';
import { Text } from './Text';

/**
 * Bottom sheet for confirmations ("Reset demo data?"). Android Back and a tap on the dimmed
 * backdrop both close it, unless `busy` (an action is running and must not be abandoned midway).
 */
export function Sheet({
  visible,
  title,
  children,
  onClose,
  busy,
}: {
  visible: boolean;
  title: string;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      visible={visible}
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
    >
      <View style={styles.root}>
        <Pressable
          style={styles.backdrop}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close"
        />
        <View
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { backgroundColor: t.card, borderColor: t.bd, paddingBottom: insets.bottom + 20 },
          ]}
        >
          <View style={[styles.grip, { backgroundColor: t.bd2 }]} />
          <Text variant="subtitle" weight="semibold" accessibilityRole="header">
            {title}
          </Text>
          {children}
        </View>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill, backgroundColor: 'rgba(0,0,0,0.45)' },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 14,
    maxWidth: 560,
    width: '100%',
    alignSelf: 'center',
  },
  grip: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 6 },
});
