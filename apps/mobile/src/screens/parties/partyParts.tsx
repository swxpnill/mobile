import { type Party, formatMobile } from '@tonnage/shared';
import { Linking, Pressable, StyleSheet, View } from 'react-native';
import { useTheme } from '../../theme/ThemeProvider';
import type { Tokens } from '../../theme/tokens';
import { Group, Icon, type IconName, IconButton, Row, SectionLabel, showToast, Text } from '../../ui';

const isMobile = (n: string) => /^\+91[6-9]\d{9}$/.test(n);

async function open(url: string, fallback: string): Promise<void> {
  try {
    await Linking.openURL(url);
  } catch {
    showToast(fallback);
  }
}
export const call = (n: string) => void open(`tel:${n}`, "Couldn't start a call on this phone");
export const whatsapp = (n: string) => void open(`https://wa.me/${n.replace(/\D/g, '')}`, "Couldn't open WhatsApp");

/** The first number, and the first WhatsApp number, of a party's contacts (header actions). */
export function firstNumbers(p: Party) {
  const all = p.contacts.flatMap((c) => c.numbers);
  return { first: all[0], firstWa: all.find((n) => n.whatsapp) };
}

/** One of the big header action tiles (Call · WhatsApp · New order / Statement). */
export function Action({
  icon,
  label,
  onPress,
  disabled,
  color = 'brt',
  accessibilityLabel,
}: {
  icon: IconName;
  label: string;
  onPress(): void;
  disabled?: boolean;
  color?: keyof Tokens;
  accessibilityLabel?: string;
}) {
  const { t } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => [
        styles.action,
        { backgroundColor: pressed ? t.act : t.card, borderColor: t.bd, opacity: disabled ? 0.5 : 1 },
      ]}
    >
      <Icon name={icon} size={20} color={t[color]} />
      <Text weight="medium" variant="caption" color={color === 'brt' ? 'tx' : color}>
        {label}
      </Text>
    </Pressable>
  );
}

/** Contacts with their numbers, call and WhatsApp buttons (boards 05 and 06). */
export function Contacts({ p }: { p: Party }) {
  return (
    <>
      <SectionLabel>Contacts</SectionLabel>
      <Group>
        {p.contacts.length === 0 ? (
          <Row>
            <Text color="tx2">No contacts yet</Text>
          </Row>
        ) : null}
        {p.contacts.map((c) => (
          <View key={c.id}>
            <Row>
              <Text weight="semibold" style={styles.fill}>
                {c.name}
              </Text>
              {c.roleLabel ? <Text variant="caption">{c.roleLabel}</Text> : null}
            </Row>
            {c.numbers.map((n) => {
              const shown = formatMobile(n.number);
              return (
                <Row key={n.id}>
                  <View style={styles.fill}>
                    <Text numeric>{shown}</Text>
                    <Text variant="caption">
                      {[n.label || (isMobile(n.number) ? 'Mobile' : 'Phone'), n.whatsapp ? 'gets WhatsApp updates' : null]
                        .filter(Boolean)
                        .join(' · ')}
                    </Text>
                  </View>
                  <IconButton icon="phone" label={`Call ${shown}`} onPress={() => call(n.number)} />
                  {n.whatsapp ? <IconButton icon="message" label={`WhatsApp ${shown}`} onPress={() => whatsapp(n.number)} /> : null}
                </Row>
              );
            })}
          </View>
        ))}
      </Group>
    </>
  );
}

export const partyStyles = StyleSheet.create({
  head: { flexDirection: 'row', gap: 14, alignItems: 'center' },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 4 },
  fill: { flex: 1, minWidth: 0 },
  actions: { flexDirection: 'row', gap: 10 },
});

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  action: {
    flex: 1,
    minHeight: 64,
    borderRadius: 14,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
    gap: 4,
  },
});
