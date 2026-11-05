import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useUnitBasis } from '../api/hooks/me';
import { useTheme } from '../theme/ThemeProvider';
import { Group, Row, Screen, SectionLabel, SegmentedControl, Text } from '../ui';
import { messageFor } from './messages';
import { ProfileCard } from './ProfileCard';
import { SignOutRow } from './SignOutRow';

export const UNIT_OPTIONS = [
  { value: 'mt', label: 'MT / ₹ per MT' },
  { value: 'kg', label: 'kg / ₹ per kg' },
] as const;

/** Supervisor's Profile tab: who and where, units, appearance, sign out. */
export function ProfileScreen() {
  const { basis, setBasis } = useUnitBasis();
  const { prefs, setPrefs } = useTheme();
  const [error, setError] = useState<string | undefined>();

  return (
    <Screen title="Profile" edges={['top']}>
      <ProfileCard />

      <SectionLabel>Units</SectionLabel>
      <SegmentedControl
        size="full"
        accessibilityLabel="Units"
        options={UNIT_OPTIONS}
        value={basis}
        onChange={(b) => {
          setError(undefined);
          setBasis(b).catch((e: unknown) => setError(messageFor(e)));
        }}
      />
      {error ? (
        <Text color="dgt" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}

      <SectionLabel>Appearance</SectionLabel>
      <Group>
        <Row>
          <Text weight="medium" style={styles.fill}>
            Theme
          </Text>
          <SegmentedControl
            accessibilityLabel="Theme"
            value={prefs.themeMode}
            onChange={(themeMode) => void setPrefs({ themeMode })}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'auto', label: 'Auto' },
            ]}
          />
        </Row>
        <Row>
          <Text weight="medium" style={styles.fill}>
            Text size
          </Text>
          <SegmentedControl
            accessibilityLabel="Text size"
            value={prefs.textSize}
            onChange={(textSize) => void setPrefs({ textSize })}
            options={[
              { value: 'normal', label: 'Normal' },
              { value: 'large', label: 'Large' },
            ]}
          />
        </Row>
      </Group>

      <View style={styles.spacer} />
      <Group>
        <SignOutRow />
      </Group>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  spacer: { flex: 1 },
});
