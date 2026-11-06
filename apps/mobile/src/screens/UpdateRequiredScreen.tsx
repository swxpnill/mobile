import { Linking, StyleSheet, View } from 'react-native';
import { Button, Screen, Text } from '../ui';
import { Brand } from './Brand';

export const PLAY_STORE_URL = 'https://play.google.com/store/apps/details?id=com.tonnage.app';

/** Blocking screen when the server no longer supports this app version (spec §9). */
export function UpdateRequiredScreen() {
  return (
    <Screen scroll={false} contentStyle={styles.content}>
      <Brand />
      <View style={styles.intro}>
        <Text variant="title" accessibilityRole="header">
          Update Tonnage
        </Text>
        <Text color="tx2" style={styles.lead}>
          This version of the app is no longer supported. Update to keep working — your data is safe
          on the server.
        </Text>
      </View>
      <View style={styles.spacer} />
      <Button onPress={() => void Linking.openURL(PLAY_STORE_URL)}>Open Play Store</Button>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, paddingTop: 56 },
  intro: { marginTop: 64, gap: 8 },
  lead: { fontSize: 15, lineHeight: 22 },
  spacer: { flex: 1 },
});
