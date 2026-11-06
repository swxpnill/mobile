import * as LocalAuthentication from 'expo-local-authentication';
import { useCallback, useEffect, useState } from 'react';
import { BackHandler, StyleSheet, View } from 'react-native';
import { useSession } from '../auth/session';
import { useTheme } from '../theme/ThemeProvider';
import { Button, Screen, Text } from '../ui';
import { Brand } from './Brand';

/** Shown after 15 idle minutes when fingerprint unlock is on. */
export function LockScreen() {
  const [failed, setFailed] = useState(false);

  const unlock = useCallback(async () => {
    setFailed(false);
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Tonnage',
      cancelLabel: 'Cancel',
    });
    if (result.success) useSession.getState().unlock();
    else setFailed(true);
  }, []);

  useEffect(() => {
    void unlock(); // ask straight away; the buttons are for retry and fallback
  }, [unlock]);

  useEffect(() => {
    // Android back must not reach the app underneath the lock.
    const sub = BackHandler.addEventListener('hardwareBackPress', () => true);
    return () => sub.remove();
  }, []);

  const { t } = useTheme();
  return (
    <View style={[StyleSheet.absoluteFill, { backgroundColor: t.bg }]} accessibilityViewIsModal>
      <Screen scroll={false} contentStyle={styles.content}>
        <Brand />
        <View style={styles.intro}>
          <Text variant="title" accessibilityRole="header">
            Tonnage is locked
          </Text>
          <Text color="tx2" style={styles.lead}>
            Use your fingerprint to continue where you left off.
          </Text>
          {failed ? (
            <Text color="dgt" accessibilityLiveRegion="polite">
              Not recognised. Try again, or sign in with a code.
            </Text>
          ) : null}
        </View>
        <View style={styles.spacer} />
        <View style={styles.actions}>
          <Button onPress={() => void unlock()}>Unlock</Button>
          <Button variant="secondary" onPress={() => void useSession.getState().signOut()}>
            Sign in with code
          </Button>
        </View>
      </Screen>
    </View>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, paddingTop: 56 },
  intro: { marginTop: 64, gap: 8 },
  lead: { fontSize: 15, lineHeight: 22 },
  spacer: { flex: 1 },
  actions: { gap: 10 },
});
