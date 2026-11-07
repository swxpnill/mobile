import type { PartySummary, PartyType } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, StyleSheet } from 'react-native';
import { useParties } from '../../api/hooks/masters';
import { useTheme } from '../../theme/ThemeProvider';
import { Avatar, Button, Group, Row, SearchField, Text, useDebouncedValue } from '../../ui';
import { Sheet } from '../../ui/Sheet';

/** Search-and-pick an active customer or broker; "Add new" opens the party form. */
export function PartyPickerSheet({
  type,
  visible,
  onPick,
  onClose,
}: {
  type: Extract<PartyType, 'customer' | 'broker'>;
  visible: boolean;
  onPick(p: PartySummary): void;
  onClose(): void;
}) {
  const router = useRouter();
  const { t } = useTheme();
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 250);
  const list = useParties({ type, active: true, ...(q ? { q } : {}) }, visible);
  const label = type === 'customer' ? 'customer' : 'broker';
  return (
    <Sheet visible={visible} title={`Choose ${label}`} onClose={onClose}>
      <SearchField value={search} onChangeText={setSearch} placeholder={`Search ${label}s`} />
      {list.isPending ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
      ) : (list.data ?? []).length === 0 ? (
        <Text color="tx2" style={styles.empty}>{q ? `No ${label}s match “${q}”` : `No ${label}s yet`}</Text>
      ) : (
        <Group>
          {(list.data ?? []).slice(0, 30).map((p) => (
            <Row key={p.id} onPress={() => onPick(p)} accessibilityLabel={`${p.name}, ${p.city}`}>
              <Avatar name={p.name} tone={type === 'customer' ? 'br' : 'vi'} size={36} />
              <Text weight="medium" style={styles.fill} numberOfLines={1}>
                {p.name}
              </Text>
              <Text variant="caption">{p.city}</Text>
            </Row>
          ))}
        </Group>
      )}
      <Button
        variant="secondary"
        onPress={() => {
          onClose();
          router.push({ pathname: '/parties/form', params: { type } });
        }}
      >
        {`Add new ${label}`}
      </Button>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  empty: { textAlign: 'center', paddingVertical: 16 },
});
