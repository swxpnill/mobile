import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useTheme } from '../src/theme/ThemeProvider';
import {
  Badge,
  Button,
  Chip,
  EmptyState,
  Group,
  Header,
  MoneyText,
  OtpInput,
  QtyText,
  Row,
  Screen,
  SectionLabel,
  SegmentedControl,
  Text,
  UnitTag,
} from '../src/ui';

/**
 * Design kit: every UI primitive on one screen, wired to the real theme prefs, so the canvas match
 * can be checked on a phone. Replaced by the sign-in route in Task 7.
 */
export default function DesignKit() {
  const { prefs, setPrefs } = useTheme();
  const [basis, setBasis] = useState<'mt' | 'kg'>('mt');
  const [code, setCode] = useState('47');
  const [chip, setChip] = useState('All');
  const [busy, setBusy] = useState(false);

  return (
    <Screen header={<Header title="Design kit" />}>
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
        <Row>
          <Text weight="medium" style={styles.fill}>
            Units
          </Text>
          <SegmentedControl<'mt' | 'kg'>
            accessibilityLabel="Units"
            value={basis}
            onChange={setBasis}
            options={[
              { value: 'mt', label: 'MT / ₹ per MT' },
              { value: 'kg', label: 'kg / ₹ per kg' },
            ]}
          />
        </Row>
      </Group>

      <SectionLabel>Numbers</SectionLabel>
      <Group>
        <Row>
          <Text color="tx2" style={styles.fill}>
            Net weight
          </Text>
          <QtyText kg={24180} basis={basis} withUnit weight="semibold" />
        </Row>
        <Row>
          <Text color="tx2" style={styles.fill}>
            Order value
          </Text>
          <MoneyText rupees={5580000} weight="semibold" />
        </Row>
        <Row>
          <Text color="tx2" style={styles.fill}>
            Short form
          </Text>
          <MoneyText rupees={5580000} short weight="semibold" />
        </Row>
      </Group>

      <SectionLabel>Tags</SectionLabel>
      <View style={styles.wrap}>
        {['AIP', 'VSL', 'KRM', 'NAP'].map((c, i) => (
          <UnitTag key={c} code={c} slot={i} />
        ))}
        <Badge kind="br" dot>
          Open
        </Badge>
        <Badge kind="wn" dot>
          Partly dispatched
        </Badge>
        <Badge kind="ok" dot>
          Completed
        </Badge>
        <Badge kind="nu">Invited</Badge>
        <Badge kind="te">Accounts</Badge>
      </View>
      <View style={styles.wrap}>
        {[
          ['All', 412],
          ['Open', 21],
          ['Partial', 17],
        ].map(([label, count]) => (
          <Chip
            key={label}
            label={String(label)}
            count={Number(count)}
            selected={chip === label}
            onPress={() => setChip(String(label))}
          />
        ))}
      </View>

      <SectionLabel>One-time code</SectionLabel>
      <OtpInput value={code} onChange={setCode} />

      <SectionLabel>Buttons</SectionLabel>
      <View style={styles.stack}>
        <Button
          loading={busy}
          onPress={() => {
            setBusy(true);
            setTimeout(() => setBusy(false), 1500);
          }}
        >
          Verify and continue
        </Button>
        <Button variant="secondary" onPress={() => {}}>
          Import from Excel
        </Button>
        <Button variant="danger" onPress={() => {}}>
          Delete forever
        </Button>
        <Button disabled onPress={() => {}}>
          Send code
        </Button>
      </View>

      <EmptyState
        title="No orders yet"
        body="Create your first order, or bring your current Excel sheet in and keep working from where you are."
        actions={[
          { label: 'Create first order', onPress: () => {} },
          { label: 'Import from Excel', onPress: () => {} },
        ]}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  wrap: { flexDirection: 'row', flexWrap: 'wrap', gap: 8, alignItems: 'center' },
  stack: { gap: 10 },
});
