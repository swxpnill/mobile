import { Redirect, Stack } from 'expo-router';
import { StyleSheet, View } from 'react-native';
import { useSession } from '../../src/auth/session';
import { ToastHost } from '../../src/ui';

/** Everything behind sign-in. Signing out (or a refused refresh) lands on sign-in. */
export default function AppLayout() {
  const status = useSession((s) => s.status);
  if (status === 'signedOut') return <Redirect href="/sign-in" />;
  return (
    <View style={styles.fill}>
      <Stack screenOptions={{ headerShown: false }} />
      <ToastHost />
    </View>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
