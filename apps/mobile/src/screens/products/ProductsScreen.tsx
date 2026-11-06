import { type Product, formatLength, toDisplayRate, unitLabel } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, ScrollView, StyleSheet, View } from 'react-native';
import { useDisplayBasis } from '../../api/hooks/me';
import { useProducts } from '../../api/hooks/masters';
import { useTheme } from '../../theme/ThemeProvider';
import { Badge, Button, Chip, EmptyState, Group, Row, Screen, SearchField, Text, useDebouncedValue } from '../../ui';
import { messageFor } from '../messages';
import { BackHeader } from '../admin/parts';

/** "Lengths 6 m, 12 m" or "No standard length". */
export const lengthsText = (p: Pick<Product, 'standardLengths'>) =>
  p.standardLengths.length ? `Lengths ${p.standardLengths.map(formatLength).join(', ')}` : 'No standard length';

/** "+₹1,500" (₹/MT) or "+₹1.500" (₹/kg). */
export const conversionText = (perMt: number | undefined, basis: ReturnType<typeof useDisplayBasis>) =>
  perMt === undefined ? '' : `+${toDisplayRate(perMt, basis)}`;

/** Canvas board 21: one product list shared by every company, grouped by category chips. */
export function ProductsScreen() {
  const router = useRouter();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const [category, setCategory] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const q = useDebouncedValue(search.trim(), 300);
  const query = useProducts(q ? { q } : {});
  const all = useMemo(() => query.data ?? [], [query.data]);
  // Chips keep the order the server sorts categories in (natural order: TMT 8 mm before 12 mm).
  const categories = useMemo(() => {
    const m = new Map<string, number>();
    for (const p of all) m.set(p.category, (m.get(p.category) ?? 0) + 1);
    return [...m.entries()];
  }, [all]);
  const shown = category && categories.some(([c]) => c === category) ? all.filter((p) => p.category === category) : all;

  return (
    <Screen
      title="Products"
      header={<BackHeader />}
      footer={<Button onPress={() => router.push('/products/form')}>Add product</Button>}
    >
      <Text variant="caption" style={styles.sub}>
        {`One list for every company · ${all.length} ${all.length === 1 ? 'product' : 'products'}`}
      </Text>
      <SearchField value={search} onChangeText={setSearch} placeholder="Search products" />
      {categories.length > 1 ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.chips}>
          <Chip label="All" count={all.length} selected={category === null} onPress={() => setCategory(null)} />
          {categories.map(([c, n]) => (
            <Chip key={c} label={c} count={n} selected={category === c} onPress={() => setCategory(category === c ? null : c)} />
          ))}
        </ScrollView>
      ) : null}
      {query.isPending ? (
        <ActivityIndicator color={t.br} accessibilityLabel="Loading products" />
      ) : query.isError ? (
        <View style={styles.gap}>
          <Text color="tx2" accessibilityRole="alert">
            {messageFor(query.error)}
          </Text>
          <Button variant="secondary" onPress={() => void query.refetch()}>
            Try again
          </Button>
        </View>
      ) : shown.length === 0 ? (
        q !== '' ? (
          <Text color="tx2" style={styles.empty}>{`No products match “${q}”`}</Text>
        ) : (
          <EmptyState icon="box" title="Add your products" body="Each product's conversion is added to the basic rate on orders." />
        )
      ) : (
        <>
          <View style={styles.head}>
            <Text variant="overline">Product</Text>
            <Text variant="overline">{`Conversion / ${unitLabel(basis)}`}</Text>
          </View>
          <Group>
            {shown.map((p) => (
              <Row
                key={p.id}
                onPress={() => router.push({ pathname: '/products/form', params: { id: p.id } })}
                accessibilityLabel={`${p.displayName}, ${lengthsText(p).toLowerCase()}, conversion ${conversionText(p.conversionPerMt, basis)} per ${unitLabel(basis)}${p.active ? '' : ', inactive'}`}
              >
                <View style={[styles.tag, { backgroundColor: t.ctl }]}>
                  <Text weight="semibold" style={{ fontSize: 11, color: t.tx2 }}>
                    {p.tag}
                  </Text>
                </View>
                <View style={styles.fill}>
                  <Text weight="medium" numberOfLines={1}>
                    {p.displayName}
                  </Text>
                  <Text variant="caption" numberOfLines={1}>
                    {lengthsText(p)}
                  </Text>
                </View>
                {p.active ? (
                  <Text weight="medium" numeric color="tx2">
                    {conversionText(p.conversionPerMt, basis)}
                  </Text>
                ) : (
                  <Badge kind="nu">Inactive</Badge>
                )}
              </Row>
            ))}
          </Group>
        </>
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  sub: { marginTop: -12 },
  chips: { gap: 8 },
  gap: { gap: 12 },
  head: { flexDirection: 'row', justifyContent: 'space-between', paddingHorizontal: 4, marginBottom: -8 },
  tag: { minWidth: 36, minHeight: 22, borderRadius: 5, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 6 },
  fill: { flex: 1, minWidth: 0 },
  empty: { textAlign: 'center', paddingVertical: 24 },
});
