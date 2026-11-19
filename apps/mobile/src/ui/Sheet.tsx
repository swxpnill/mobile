import type { ReactNode } from 'react';
import { useReduceMotion } from '../a11y/useReduceMotion';
import { KeyboardAvoidingView, Modal, Pressable, StyleSheet, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '../auth/session';
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
  header,
}: {
  visible: boolean;
  /** Shown as the heading, and the sheet's spoken name when `header` replaces it. */
  title: string;
  /** A custom heading row (avatar, title, close) in place of the plain title. */
  header?: ReactNode;
  children: ReactNode;
  onClose(): void;
  busy?: boolean;
}) {
  const { t } = useTheme();
  const insets = useSafeAreaInsets();
  // A Modal is its own native window: the lock screen cannot cover it, so it hides while locked.
  const locked = useSession((s) => s.status === 'locked');
  const reduceMotion = useReduceMotion();
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      testID="sheet-modal"
      visible={visible && !locked}
      transparent
      animationType={reduceMotion ? 'fade' : 'slide'}
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={close}
    >
      {/* The sheet rides above the on-screen keyboard (Android is edge-to-edge, so nothing resizes by itself). */}
      <KeyboardAvoidingView behavior="padding" style={styles.root}>
        <Pressable
          testID="sheet-backdrop"
          style={[styles.backdrop, { backgroundColor: t.scrim }]}
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close"
          accessibilityState={{ disabled: Boolean(busy) }}
        />
        <View
          accessibilityViewIsModal
          accessibilityLabel={header ? title : undefined}
          style={[
            styles.sheet,
            { backgroundColor: t.card, borderColor: t.bd, paddingBottom: insets.bottom + 20 },
          ]}
        >
          <View style={[styles.grip, { backgroundColor: t.bd2 }]} />
          {header ?? (
            <Text variant="subtitle" weight="semibold" accessibilityRole="header">
              {title}
            </Text>
          )}
          {children}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, justifyContent: 'flex-end' },
  backdrop: { ...StyleSheet.absoluteFill },
  sheet: {
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderWidth: 1,
    paddingHorizontal: 20,
    paddingTop: 10,
    gap: 14,
    maxWidth: 560,
    maxHeight: '94%',
    width: '100%',
    alignSelf: 'center',
  },
  grip: { alignSelf: 'center', width: 36, height: 4, borderRadius: 2, marginBottom: 6 },
});
