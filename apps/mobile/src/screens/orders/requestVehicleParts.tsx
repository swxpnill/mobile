import { type ReactNode } from 'react';
import { Pressable, StyleSheet, TextInput, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import { MIN_TOUCH, SMALL_TEXT_MAX_SCALE, fontFamily } from '../../theme/tokens';
import { Icon, Text, UnitTag } from '../../ui';
import { inputTheme } from '../../ui/inputTheme';

/**
 * Canvas 40 controls. Radios and checkboxes use the brand accent (`inv`), as the canvas draws
 * them; an empty one is outlined in `tx3` so it keeps 3:1 against the card (WCAG 1.4.11).
 */
function RadioMark({ on }: { on: boolean }) {
  const { t } = useTheme();
  return <View style={[styles.radio, on ? { borderColor: t.inv, borderWidth: 6 } : { borderColor: t.tx3, borderWidth: 1.5 }]} />;
}

/** One saved number of the party: "Name · label", the number, and WhatsApp or "call only". */
export function NumberRow({
  title,
  label,
  number,
  whatsapp,
  checked,
  onPress,
}: {
  title: string;
  label: string;
  number: string;
  whatsapp: boolean;
  checked: boolean;
  onPress(): void;
}) {
  const { t } = useTheme();
  const shown = whatsapp ? number : `${number} · call only`;
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${title}${label ? `, ${label}` : ''}, ${number}, ${whatsapp ? 'WhatsApp' : 'call only'}`}
      accessibilityState={{ checked, selected: checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.opt, pressed ? { backgroundColor: t.act } : null]}
    >
      <RadioMark on={checked} />
      <View style={styles.fill}>
        <Text weight="medium" numberOfLines={1}>
          {title}
          {label ? <Text variant="caption">{` · ${label}`}</Text> : null}
        </Text>
        <Text variant="caption" numeric>
          {shown}
        </Text>
      </View>
      {whatsapp ? (
        <View style={[styles.waTag, { backgroundColor: t.oks }]}>
          <Text weight="semibold" color="okt" style={styles.tagText} maxFontSizeMultiplier={SMALL_TEXT_MAX_SCALE}>
            WhatsApp
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

/** A plain row in a group (the only party; "Nothing pending on this order"). */
export function PlainRow({ children }: { children: ReactNode }) {
  return <View style={styles.opt}>{children}</View>;
}

/** "One company": an open sub-order with what is pending on it. */
export function SubOrderRow({
  code,
  slot,
  name,
  pending,
  checked,
  onPress,
}: {
  code: string;
  slot: number;
  name: string;
  pending: string;
  checked: boolean;
  onPress(): void;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={`${code} · ${name}, ${pending} pending`}
      accessibilityState={{ checked, selected: checked }}
      onPress={onPress}
      style={({ pressed }) => [styles.opt, pressed ? { backgroundColor: t.act } : null]}
    >
      <RadioMark on={checked} />
      <View style={[styles.fill, styles.inline]}>
        <UnitTag code={code} slot={slot} />
        <Text weight="medium" numberOfLines={1} style={styles.fill}>
          {name}
        </Text>
      </View>
      <Text variant="caption" numeric>{`${pending} pending`}</Text>
    </Pressable>
  );
}

/** "All pending": a line as it will be asked for. */
export function LineSummaryRow({ code, slot, name, qty }: { code: string; slot: number; name: string; qty: string }) {
  return (
    <View style={styles.opt} accessible accessibilityLabel={`${code}, ${name}, ${qty}`}>
      <View style={[styles.fill, styles.inline]}>
        <UnitTag code={code} slot={slot} />
        {/* Two lines: the length tells two lines of one size apart, so it is never cut off. */}
        <Text weight="medium" numberOfLines={2} style={styles.fill}>
          {name}
        </Text>
      </View>
      <Text weight="medium" numeric>
        {qty}
      </Text>
    </View>
  );
}

/** "Pick lines": tick, the line with its pending, and the quantity in the viewer's unit. */
export function PickLineRow({
  code,
  slot,
  name,
  caption,
  unit,
  on,
  value,
  onToggle,
  onChangeText,
  onBlur,
  decimal,
}: {
  code: string;
  slot: number;
  name: string;
  caption: string;
  unit: string;
  on: boolean;
  value: string;
  onToggle(): void;
  onChangeText(text: string): void;
  onBlur(): void;
  decimal: boolean;
}) {
  const { t, scheme, scale } = useTheme();
  return (
    <View style={[styles.opt, styles.pick]}>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel={`Include ${name}`}
        accessibilityState={{ checked: on }}
        onPress={onToggle}
        style={styles.boxHit}
      >
        <View style={[styles.box, on ? { backgroundColor: t.inv } : { borderColor: t.tx3, borderWidth: 1.5 }]}>
          {on ? <Icon name="check" size={14} color={t.invtx} strokeWidth={3} /> : null}
        </View>
      </Pressable>
      <View style={styles.fill}>
        <View style={styles.inline}>
          <UnitTag code={code} slot={slot} />
          <Text weight="medium" numberOfLines={2} style={styles.fill}>
            {name}
          </Text>
        </View>
        <Text variant="caption" numeric>
          {caption}
        </Text>
      </View>
      <View style={[styles.qty, { borderColor: on ? t.bd2 : t.bd, backgroundColor: t.card }]}>
        <TextInput
          {...inputTheme(t, scheme)}
          accessibilityLabel={`${unit} for ${name}`}
          value={value}
          onChangeText={onChangeText}
          onBlur={onBlur}
          keyboardType={decimal ? 'decimal-pad' : 'number-pad'}
          selectTextOnFocus
          maxLength={12}
          style={[styles.qtyInput, { color: on ? t.tx : t.tx3, fontFamily: fontFamily.semibold, fontSize: 14 * scale }]}
        />
        <Text variant="caption">{unit}</Text>
      </View>
    </View>
  );
}

/** The blue total band at the foot of the Material group. */
export function TotalRow({ qty }: { qty: string }) {
  const { t } = useTheme();
  return (
    <View style={[styles.total, { backgroundColor: t.brs }]} accessible accessibilityLabel={`Total to request, ${qty}`}>
      <Text weight="medium" color="brt">
        Total to request
      </Text>
      <Text weight="semibold" color="brt" numeric style={styles.totalQty}>
        {qty}
      </Text>
    </View>
  );
}

/** A small text action in an overline row ("Copy", "Update message"). */
export function LinkButton({ label, accessibilityLabel, onPress }: { label: string; accessibilityLabel?: string; onPress(): void }) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      onPress={onPress}
      hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
      style={({ pressed }) => [styles.link, pressed ? styles.pressed : null]}
    >
      <Text variant="caption" weight="medium" color="brt">
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  opt: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 12, paddingHorizontal: 14, minHeight: 56 },
  pick: { minHeight: 64, paddingLeft: 6, gap: 6 },
  radio: { width: 20, height: 20, borderRadius: 10 },
  boxHit: { width: MIN_TOUCH, height: MIN_TOUCH, alignItems: 'center', justifyContent: 'center' },
  box: { width: 20, height: 20, borderRadius: 6, alignItems: 'center', justifyContent: 'center' },
  waTag: { minHeight: 18, paddingHorizontal: 6, borderRadius: 5, justifyContent: 'center' },
  tagText: { fontSize: 11, lineHeight: 14 },
  qty: { width: 104, height: 40, borderRadius: 10, borderWidth: 1, flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 10 },
  qtyInput: { flex: 1, minWidth: 0, textAlign: 'right', padding: 0 },
  total: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline', paddingVertical: 12, paddingHorizontal: 14 },
  totalQty: { fontSize: 17, lineHeight: 22 },
  // 32 high and at least 44 wide with the hit slop (a short word like "Copy" is ~28 wide).
  link: { minHeight: 32, minWidth: 44, alignItems: 'center', justifyContent: 'center' },
  pressed: { opacity: 0.6 },
});
