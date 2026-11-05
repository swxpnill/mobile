import { formatMobile } from '@tonnage/shared';
import { StyleSheet, View } from 'react-native';
import { useCompanies, usePlants } from '../api/hooks/companies';
import { useMe } from '../api/hooks/me';
import { ROLE_LABEL, scopeLine } from '../nav/roles';
import { useTheme } from '../theme/ThemeProvider';
import { initials, Text } from '../ui';

/** Canvas More header: initials tile, name, "Owner · all 4 units · +91 98261 00012". */
export function ProfileCard() {
  const { t } = useTheme();
  const { data: me } = useMe();
  const { data: companies } = useCompanies();
  const { data: plants } = usePlants();
  if (!me) return null;
  const scope = scopeLine(me.role, me.plantIds, companies, plants);
  // Non-breaking spaces keep the phone number on one line when the caption wraps.
  const mobile = formatMobile(me.mobile).replace(/ /g, ' ');
  const line = [ROLE_LABEL[me.role], scope, mobile].filter(Boolean).join(' · ');
  return (
    <View
      style={[styles.card, { backgroundColor: t.card, borderColor: t.bd }]}
      accessible
      accessibilityLabel={`${me.name}. ${line}`}
    >
      <View style={[styles.avatar, { backgroundColor: t.brs }]}>
        <Text weight="semibold" color="brt">
          {initials(me.name)}
        </Text>
      </View>
      <View style={styles.fill}>
        <Text weight="semibold" style={{ fontSize: 16 }}>
          {me.name}
        </Text>
        <Text variant="caption">{line}</Text>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 14,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 16,
    borderWidth: 1,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
