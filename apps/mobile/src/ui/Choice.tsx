import { Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../theme/ThemeProvider';
import { MIN_TOUCH } from '../theme/tokens';
import { Icon } from './Icon';
import { Text } from './Text';

/** Radio dot or checkbox square, drawn to the canvas (amber accent on Invite user). */
function Mark({
  kind,
  checked,
  disabled,
}: {
  kind: 'radio' | 'checkbox';
  checked: boolean;
  disabled?: boolean;
}) {
  const { t } = useTheme();
  const on = checked && !disabled ? t.wn : checked ? t.tx3 : t.bd2;
  if (kind === 'radio') {
    return <View style={[styles.radio, { borderColor: on, borderWidth: checked ? 6 : 1.5 }]} />;
  }
  return (
    <View
      style={[
        styles.box,
        checked ? { backgroundColor: on, borderColor: on } : { borderColor: t.bd2 },
      ]}
    >
      {checked ? <Icon name="check" size={14} color="#FFFFFF" /> : null}
    </View>
  );
}

/**
 * A large selectable card (role choice on Invite user): title, one-line detail, radio dot.
 * Announced as a radio with its checked state.
 */
export function ChoiceCard({
  title,
  detail,
  checked,
  onPress,
  disabled,
}: {
  title: string;
  detail?: string;
  checked: boolean;
  onPress(): void;
  disabled?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="radio"
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.card,
        { backgroundColor: t.card, borderColor: t.bd2 },
        checked ? { borderColor: t.wn, borderWidth: 1.5 } : null,
        disabled ? styles.dim : null,
        pressed ? { backgroundColor: t.act } : null,
      ]}
    >
      {checked ? <View style={[styles.halo, { borderColor: t.wns }]} /> : null}
      <Mark kind="radio" checked={checked} disabled={disabled} />
      <View style={styles.fill}>
        <Text weight="medium">{title}</Text>
        {detail ? <Text variant="caption">{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

/** A row inside a `Group` with a radio (pick one) or a checkbox (pick several). */
export function ChoiceRow({
  kind,
  title,
  detail,
  checked,
  onPress,
  disabled,
}: {
  kind: 'radio' | 'checkbox';
  title: string;
  detail?: string;
  checked: boolean;
  onPress(): void;
  disabled?: boolean;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole={kind}
      accessibilityLabel={detail ? `${title}. ${detail}` : title}
      accessibilityState={{ checked, disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.row,
        disabled ? styles.dim : null,
        pressed ? { backgroundColor: t.act } : null,
      ]}
    >
      <Mark kind={kind} checked={checked} disabled={disabled} />
      <View style={styles.fill}>
        <Text weight="medium">{title}</Text>
        {detail ? <Text variant="caption">{detail}</Text> : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  dim: { opacity: 0.5 },
  card: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
    minHeight: MIN_TOUCH + 12,
  },
  halo: {
    position: 'absolute',
    top: -5,
    bottom: -5,
    left: -5,
    right: -5,
    borderRadius: 18,
    borderWidth: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 13,
    paddingHorizontal: 16,
    minHeight: MIN_TOUCH + 12,
  },
  radio: { width: 20, height: 20, borderRadius: 10, marginTop: 1 },
  box: {
    width: 20,
    height: 20,
    borderRadius: 6,
    borderWidth: 1.5,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
