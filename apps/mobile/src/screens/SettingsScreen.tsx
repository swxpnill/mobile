import {
  can,
  type PricingMethod,
  type TenantSettings,
  toDisplayQty,
  parseQtyInput,
  unitLabel,
} from '@tonnage/shared';
import Constants from 'expo-constants';
import * as LocalAuthentication from 'expo-local-authentication';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, StyleSheet, View } from 'react-native';
import { parseAgedDays } from '../admin/forms';
import { useMe, useUnitBasis } from '../api/hooks/me';
import { useTenantSettings, useUpdateTenantSettings } from '../api/hooks/settings';
import { useTheme } from '../theme/ThemeProvider';
import {
  Group,
  IconTile,
  MenuRow,
  Row,
  Screen,
  SectionLabel,
  SegmentedControl,
  Switch,
  Text,
  TextField,
} from '../ui';
import { BackHeader } from './admin/parts';
import { messageFor } from './messages';
import { UNIT_OPTIONS } from './ProfileScreen';

/** A typo like 9999999 would make every order line count as complete; 100 MT is far above use. */
export const MAX_TOLERANCE_KG = 100_000;

const PRICING_OPTIONS: { value: PricingMethod; label: string }[] = [
  { value: 'basic_conversion', label: 'Basic + conversion' },
  { value: 'direct', label: 'Direct rate' },
];

/** Canvas "Settings": appearance and units for everyone; order rules for the owner. */
export function SettingsScreen() {
  const { data: me } = useMe();
  const { prefs, setPrefs } = useTheme();
  const { basis, setBasis } = useUnitBasis();
  const [unitError, setUnitError] = useState<string | undefined>();
  const owner = me ? can(me.role, 'settings.manage') : false;

  return (
    <Screen title="Settings" keyboard header={<BackHeader />}>
      <SectionLabel>Appearance</SectionLabel>
      <Group>
        <Row>
          <IconTile icon="sliders" tone="bl" size={32} />
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
          <IconTile icon="info" tone="vi" size={32} />
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

      <SectionLabel>Units</SectionLabel>
      <SegmentedControl
        size="full"
        accessibilityLabel="Units"
        options={UNIT_OPTIONS}
        value={basis}
        onChange={(b) => {
          setUnitError(undefined);
          setBasis(b).catch((e: unknown) => setUnitError(messageFor(e)));
        }}
      />
      <Text variant="caption" style={styles.note}>
        {unitError ??
          'Every quantity and rate in the app follows this. Rupee totals stay the same.'}
      </Text>

      {owner ? <OrderRules /> : null}

      <SectionLabel>Security</SectionLabel>
      <Group>
        <FingerprintRow />
      </Group>

      <SectionLabel>Coming soon</SectionLabel>
      <Group>
        <MenuRow icon="info" tone="gr" label="WhatsApp & alerts" comingSoon />
        <MenuRow icon="upload" tone="am" label="Import and export" comingSoon />
      </Group>

      <Text variant="caption" style={styles.footer}>
        {`Tonnage v${Constants.expoConfig?.version ?? '1.0.0'} · ${
          Platform.OS === 'ios' ? 'iOS' : 'Android'
        }`}
      </Text>
    </Screen>
  );
}

/** Owner-only business rules (spec §4 tenant settings). Each change saves on its own. */
function OrderRules() {
  const { t } = useTheme();
  const settings = useTenantSettings();
  const save = useUpdateTenantSettings();
  const { basis } = useUnitBasis();
  const [error, setError] = useState<string | undefined>();

  const patch = async (p: Partial<TenantSettings>) => {
    setError(undefined);
    try {
      await save.mutateAsync(p);
    } catch (e) {
      setError(messageFor(e));
      throw e;
    }
  };

  const s = settings.data;
  return (
    <>
      <SectionLabel>Orders &amp; dispatch</SectionLabel>
      {!s ? (
        settings.isError ? (
          <Text color="tx2" accessibilityRole="alert">
            {messageFor(settings.error)}
          </Text>
        ) : (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading settings" />
        )
      ) : (
        <Group>
          <Row>
            <IconTile icon="wallet" tone="gr" size={32} />
            <View style={styles.fill}>
              <Text weight="medium">Default pricing</Text>
              <Text variant="caption">New orders start with this</Text>
            </View>
          </Row>
          <View style={styles.inset}>
            <SegmentedControl
              size="full"
              accessibilityLabel="Default pricing"
              value={s.defaultPricing}
              options={PRICING_OPTIONS}
              onChange={(defaultPricing) => void patch({ defaultPricing }).catch(() => undefined)}
            />
          </View>
          <NumberSetting
            // A new instance per unit basis: text typed in MT is never read back as kg.
            key={`tolerance-${basis}`}
            icon="scales"
            label={`Completion tolerance (${unitLabel(basis)})`}
            title="Completion tolerance"
            caption="An order line counts as complete within ± this much"
            prefix="±"
            display={toDisplayQty(s.completionToleranceKg, basis)}
            keyboardType={basis === 'mt' ? 'decimal-pad' : 'number-pad'}
            suffix={unitLabel(basis)}
            parse={(text) => {
              const r = parseQtyInput(text, basis);
              if (r.ok) {
                return r.value <= MAX_TOLERANCE_KG
                  ? r
                  : {
                      ok: false,
                      error: `Keep it within ${toDisplayQty(MAX_TOLERANCE_KG, basis, { withUnit: true }).replace('.000', '')}`,
                    };
              }
              return {
                ok: false,
                error:
                  r.error === 'TOO_MANY_DECIMALS'
                    ? 'Up to 3 decimals in MT'
                    : basis === 'kg'
                      ? 'Enter whole kg, e.g. 1000'
                      : 'Enter MT, e.g. 1.000',
              };
            }}
            onSave={(completionToleranceKg) => patch({ completionToleranceKg })}
            current={s.completionToleranceKg}
          />
          <NumberSetting
            icon="info"
            label="Flag aged orders after (days)"
            title="Flag aged orders after"
            caption="Shown in amber on Home"
            display={String(s.agedOrderDays)}
            keyboardType="number-pad"
            suffix="days"
            parse={parseAgedDays}
            onSave={(agedOrderDays) => patch({ agedOrderDays })}
            current={s.agedOrderDays}
          />
          <Row>
            <IconTile icon="orders" tone="bl" size={32} />
            <View style={styles.fill}>
              <Text weight="medium">Order number format</Text>
              <Text variant="caption">Numbers restart each financial year</Text>
            </View>
            <Text variant="caption">{s.orderNumberFormat}</Text>
          </Row>
          <Row>
            <IconTile icon="shield" tone="rd" size={32} />
            <View style={styles.fill}>
              <Text weight="medium">Delete after dispatch</Text>
              <Text variant="caption">Owner only. Delete removes every trace.</Text>
            </View>
            <Switch
              label="Allow delete after dispatch"
              value={s.allowHardDeleteAfterDispatch}
              disabled={save.isPending}
              onChange={(allowHardDeleteAfterDispatch) =>
                void patch({ allowHardDeleteAfterDispatch }).catch(() => undefined)
              }
            />
          </Row>
        </Group>
      )}
      {error ? (
        <Text color="dgt" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
    </>
  );
}

/**
 * A number edited in place. Saves on blur or Done when it parses and differs from the server's
 * value; anything invalid stays on screen with the reason and is not sent.
 */
function NumberSetting({
  icon,
  label,
  title,
  caption,
  prefix,
  suffix,
  display,
  current,
  keyboardType,
  parse,
  onSave,
}: {
  icon: 'scales' | 'info';
  label: string;
  title: string;
  caption: string;
  prefix?: string;
  suffix: string;
  display: string;
  current: number;
  keyboardType: 'decimal-pad' | 'number-pad';
  parse(text: string): { ok: true; value: number } | { ok: false; error: string };
  onSave(value: number): Promise<void>;
}) {
  const [text, setText] = useState(display);
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | undefined>();
  // Done fires submit and then blur: one save per edit.
  const inFlight = useRef(false);

  // Follow the server value whenever the field is neither being edited nor saving (while saving,
  // the typed value stays; it is replaced by the saved one, or the old one if the save failed).
  useEffect(() => {
    if (!editing && !saving) setText(display);
  }, [display, editing, saving]);

  const commit = async () => {
    if (inFlight.current) return;
    const r = parse(text);
    if (!r.ok) {
      setError(r.error);
      setEditing(true); // keep what they typed so they can fix it
      return;
    }
    setError(undefined);
    setEditing(false);
    if (r.value === current) return;
    inFlight.current = true;
    setSaving(true);
    try {
      await onSave(r.value);
    } catch {
      // The section shows the error; the field goes back to the saved value.
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  };

  return (
    <View>
      <Row>
        <IconTile icon={icon} tone="am" size={32} />
        <View style={styles.fill}>
          <Text weight="medium">{title}</Text>
          <Text
            variant="caption"
            color={error ? 'dgt' : undefined}
            accessibilityLiveRegion="polite"
          >
            {error ?? caption}
          </Text>
        </View>
        <View style={styles.numberBox}>
          <TextField
            label={label}
            hideLabel
            prefix={prefix}
            value={text}
            onChangeText={(v) => {
              setEditing(true);
              setError(undefined);
              setText(v);
            }}
            onFocus={() => setEditing(true)}
            onBlur={() => void commit()}
            onSubmitEditing={() => void commit()}
            keyboardType={keyboardType}
            returnKeyType="done"
            selectTextOnFocus
            maxLength={10}
            error={error ? ' ' : undefined}
          />
        </View>
        <Text variant="caption" style={styles.unit}>
          {suffix}
        </Text>
      </Row>
    </View>
  );
}

function FingerprintRow() {
  const { prefs, setPrefs } = useTheme();
  const [available, setAvailable] = useState<boolean | null>(null);
  const [error, setError] = useState<string | undefined>();

  useEffect(() => {
    let live = true;
    void (async () => {
      const ok =
        (await LocalAuthentication.hasHardwareAsync()) &&
        (await LocalAuthentication.isEnrolledAsync());
      if (live) setAvailable(ok);
    })().catch(() => live && setAvailable(false));
    return () => {
      live = false;
    };
  }, []);

  const toggle = async (on: boolean) => {
    setError(undefined);
    if (on) {
      // Prove the fingerprint works before relying on it to unlock the app.
      const r = await LocalAuthentication.authenticateAsync({
        promptMessage: 'Confirm your fingerprint',
        cancelLabel: 'Cancel',
      });
      if (!r.success) {
        setError('Fingerprint not confirmed. Unlock stays off.');
        return;
      }
    }
    await setPrefs({ fingerprint: on });
  };

  return (
    <Row>
      <IconTile icon="shield" tone="te" size={32} />
      <View style={styles.fill}>
        <Text weight="medium">Fingerprint unlock</Text>
        <Text variant="caption" color={error ? 'dgt' : undefined}>
          {error ??
            (available === false
              ? 'Add a fingerprint in the phone settings to use this'
              : 'Asks after 15 minutes away')}
        </Text>
      </View>
      <Switch
        label="Fingerprint unlock"
        value={prefs.fingerprint && available !== false}
        disabled={!available}
        onChange={(on) => void toggle(on)}
      />
    </Row>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  inset: { paddingHorizontal: 16, paddingBottom: 14 },
  note: { paddingHorizontal: 4, marginTop: -8 },
  numberBox: { width: 112 },
  unit: { width: 34 },
  footer: { textAlign: 'center', marginTop: 8 },
});
