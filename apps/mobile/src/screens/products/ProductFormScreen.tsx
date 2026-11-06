import {
  type LengthUnit,
  LENGTH_UNITS,
  type Product,
  formatLength,
  parseRateInput,
  productBodySchema,
  productDisplayName,
  toDisplayRate,
  unitLabel,
} from '@tonnage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { ApiError } from '../../api/client';
import { currentIdentity } from '../../api/hooks/cache';
import { byCode, useCompanies } from '../../api/hooks/companies';
import { useDisplayBasis } from '../../api/hooks/me';
import {
  productKey,
  useCreateProduct,
  useDeleteProduct,
  useProduct,
  useProducts,
  useUpdateProduct,
} from '../../api/hooks/masters';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { useDraft } from '../../masters/useDraft';
import { useDiscardGuard } from '../../nav/discardGuard';
import { useTheme } from '../../theme/ThemeProvider';
import {
  Button,
  Chip,
  ChoiceRow,
  ConfirmSheet,
  EmptyState,
  Group,
  Row,
  Screen,
  SectionLabel,
  SegmentedControl,
  showToast,
  Switch,
  Text,
  TextField,
} from '../../ui';
import { MSG, messageFor } from '../messages';
import { BackHeader, FormMessage, firstTryNote } from '../admin/parts';

/** Add (no id) or edit a product — canvas board 22 plus the companies that make it (spec §4). */
export function ProductFormScreen({ id }: { id?: string }) {
  const { t } = useTheme();
  const product = useProduct(id);
  if (id !== undefined && !product.data) {
    return (
      <Screen header={<BackHeader />}>
        {product.isPending ? (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        ) : (
          <EmptyState
            icon="box"
            title="Not found"
            body={product.isError ? messageFor(product.error) : MSG.notFound}
            actions={product.isError ? [{ label: 'Try again', onPress: () => void product.refetch() }] : []}
          />
        )}
      </Screen>
    );
  }
  return <ProductForm key={product.data?.id ?? 'new'} product={product.data} />;
}

interface Draft {
  category: string;
  grade: string;
  sizeLabel: string;
  conversion: string;
  standardLengths: { value: number; unit: LengthUnit }[];
  companyIds: string[];
  active: boolean;
}

const rateText = (perMt: number, basis: ReturnType<typeof useDisplayBasis>) =>
  toDisplayRate(perMt, basis).replace('₹', '').replace(/,/g, '');

const EMPTY: Draft = { category: '', grade: '', sizeLabel: '', conversion: '', standardLengths: [], companyIds: [], active: true };

function draftOf(p: Product | undefined, basis: ReturnType<typeof useDisplayBasis>): Draft {
  if (!p) return EMPTY;
  return {
    category: p.category,
    grade: p.grade,
    sizeLabel: p.sizeLabel,
    conversion: p.conversionPerMt === undefined ? '' : rateText(p.conversionPerMt, basis),
    standardLengths: p.standardLengths.map((l) => ({ ...l })),
    companyIds: [...p.companyIds],
    active: p.active,
  };
}

function ProductForm({ product }: { product: Product | undefined }) {
  const router = useRouter();
  const qc = useQueryClient();
  const basis = useDisplayBasis();
  const { data: companies } = useCompanies();
  const { data: existing } = useProducts();
  const create = useCreateProduct();
  const update = useUpdateProduct();
  const del = useDeleteProduct();
  const submitKey = useSubmitKey();
  const once = useSingleFlight();
  const [base, setBase] = useState(product);
  const initial = useMemo(() => draftOf(product, basis), [product, basis]);
  const [d, setD] = useDraft<Draft>(initial, (x, y) => JSON.stringify(x) === JSON.stringify(y));
  const [newCategory, setNewCategory] = useState(false);
  const [length, setLength] = useState('');
  const [lengthUnit, setLengthUnit] = useState<LengthUnit>('m');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string>();
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [inUse, setInUse] = useState(false);
  const guard = useDiscardGuard(JSON.stringify(d) !== JSON.stringify(initial));
  const patch = (c: Partial<Draft>) => setD((x) => ({ ...x, ...c }));

  const categories = useMemo(() => {
    const list = [...new Set((existing ?? []).map((p) => p.category))];
    return d.category && !list.includes(d.category) ? [...list, d.category] : list;
  }, [existing, d.category]);
  const preview = d.sizeLabel.trim() ? productDisplayName(d) : '';
  const allCompanies = byCode(companies ?? []);

  const addLength = () => {
    const value = Number(length);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      setErrors((e) => ({ ...e, length: 'A whole number from 1 to 100' }));
      return;
    }
    if (d.standardLengths.some((l) => l.value === value && l.unit === lengthUnit)) {
      setErrors((e) => ({ ...e, length: 'Already listed' }));
      return;
    }
    setErrors((e) => Object.fromEntries(Object.entries(e).filter(([k]) => k !== 'length')));
    patch({ standardLengths: [...d.standardLengths, { value, unit: lengthUnit }] });
    setLength('');
  };

  const submit = async () => {
    setFormError(undefined);
    const errs: Record<string, string> = {};
    let conversionPerMt = 0;
    if (d.conversion.trim() !== '') {
      const r = parseRateInput(d.conversion, basis);
      if (r.ok) conversionPerMt = r.value;
      else errs.conversionPerMt = r.error === 'TOO_MANY_DECIMALS' ? 'Up to 3 decimals' : 'Enter a number';
    }
    const parsed = productBodySchema.safeParse({ ...d, conversionPerMt });
    if (!parsed.success) {
      for (const i of parsed.error.issues) errs[String(i.path[0])] ??= i.message.startsWith('Too small') ? 'Required' : i.message;
    }
    if (!parsed.success || Object.keys(errs).length > 0) {
      setErrors(errs);
      return;
    }
    setErrors({});
    const identity = currentIdentity();
    try {
      if (!base) {
        const p = await create.mutateAsync({ body: parsed.data, key: submitKey.key() });
        submitKey.settle();
        if (currentIdentity() !== identity) return;
        showToast(p.displayName === productDisplayName(parsed.data) ? `${p.displayName} added` : firstTryNote(p.displayName));
      } else {
        await update.mutateAsync({ id: base.id, body: { ...parsed.data, version: base.version, active: d.active } });
        if (currentIdentity() !== identity) return;
        showToast('Saved');
      }
      guard.allow();
      router.back();
    } catch (e) {
      if (!base) submitKey.settle(e);
      if (currentIdentity() !== identity) return;
      if (e instanceof ApiError && e.code === 'STALE' && base) {
        showToast(MSG.stale);
        await qc.refetchQueries({ queryKey: productKey(base.id) });
        const fresh = qc.getQueryData<Product>(productKey(base.id));
        if (fresh) {
          setBase(fresh);
          setD(draftOf(fresh, basis));
        }
      } else if (e instanceof ApiError && e.code === 'VALIDATION') {
        const detail = (e.details as { path: string[]; message: string }[] | undefined)?.[0];
        if (detail?.path[0]) setErrors({ [detail.path[0]]: detail.message });
        else setFormError(messageFor(e));
      } else setFormError(messageFor(e));
    }
  };

  const remove = async () => {
    if (!base) return;
    try {
      await del.mutateAsync(base.id);
      setConfirmDelete(false);
      showToast(`${base.displayName} deleted`);
      guard.allow();
      router.back();
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PRODUCT_IN_USE') setInUse(true);
      else {
        setConfirmDelete(false);
        setFormError(messageFor(e));
      }
    }
  };

  const makeInactive = async () => {
    if (!base) return;
    try {
      const saved = await update.mutateAsync({
        id: base.id,
        body: {
          category: base.category,
          grade: base.grade,
          sizeLabel: base.sizeLabel,
          conversionPerMt: base.conversionPerMt ?? 0,
          standardLengths: base.standardLengths,
          companyIds: base.companyIds,
          version: base.version,
          active: false,
        },
      });
      setBase(saved);
      patch({ active: false });
      setConfirmDelete(false);
      setInUse(false);
      showToast(`${base.displayName} is inactive`);
    } catch (e) {
      setInUse(false);
      setConfirmDelete(false);
      setFormError(messageFor(e));
    }
  };

  const busy = create.isPending || update.isPending || del.isPending;

  return (
    <Screen
      title={product ? 'Edit product' : 'Add product'}
      keyboard
      header={<BackHeader />}
      footer={
        <>
          <FormMessage>{formError}</FormMessage>
          <View style={styles.footer}>
            {product ? (
              <Button variant="secondary" onPress={() => setConfirmDelete(true)} disabled={busy}>
                Delete
              </Button>
            ) : null}
            <Button onPress={() => void once(submit)} loading={create.isPending || update.isPending} disabled={busy} style={styles.fill}>
              Save product
            </Button>
          </View>
        </>
      }
    >
      {guard.sheet}
      <Text weight="medium" variant="caption">
        Category
      </Text>
      <View style={styles.chips}>
        {categories.map((c) => (
          <Chip key={c} label={c} selected={!newCategory && d.category === c} onPress={() => { setNewCategory(false); patch({ category: c }); }} />
        ))}
        <Chip label="+ New" selected={newCategory} onPress={() => { setNewCategory(true); patch({ category: '' }); }} />
      </View>
      {newCategory ? (
        <TextField label="New category" value={d.category} onChangeText={(category) => patch({ category })} error={errors.category} autoCapitalize="words" maxLength={30} />
      ) : errors.category ? (
        <FormMessage>Choose a category</FormMessage>
      ) : null}
      <TextField label="Grade" value={d.grade} onChangeText={(grade) => patch({ grade })} hint="Optional, e.g. Fe500D" maxLength={30} />
      <TextField label="Size" value={d.sizeLabel} onChangeText={(sizeLabel) => patch({ sizeLabel })} error={errors.sizeLabel} hint="e.g. 12 mm or 50 × 50 × 5" maxLength={30} />
      {preview ? (
        <Group>
          <Row>
            <Text variant="caption" style={styles.fill}>
              Shown in orders as
            </Text>
            <Text weight="medium">{preview}</Text>
          </Row>
        </Group>
      ) : null}
      <TextField
        label="Conversion"
        prefix="+₹"
        value={d.conversion}
        onChangeText={(conversion) => patch({ conversion })}
        error={errors.conversionPerMt}
        hint={`Per ${unitLabel(basis)}. Added to the basic rate when an order uses “basic + conversion”.`}
        keyboardType="decimal-pad"
        maxLength={12}
      />

      <SectionLabel>Standard lengths</SectionLabel>
      <View style={styles.chips}>
        {d.standardLengths.map((l, i) => (
          <Chip key={`${l.value}${l.unit}`} label={`${formatLength(l)} ✕`} selected onPress={() => patch({ standardLengths: d.standardLengths.filter((_, j) => j !== i) })} />
        ))}
      </View>
      <View style={styles.inline}>
        <View style={styles.fill}>
          <TextField label="New length" value={length} onChangeText={setLength} error={errors.length} keyboardType="number-pad" maxLength={3} />
        </View>
        <SegmentedControl accessibilityLabel="Length unit" value={lengthUnit} onChange={(u: LengthUnit) => setLengthUnit(u)} options={LENGTH_UNITS.map((u) => ({ value: u, label: u }))} />
        <Button variant="secondary" onPress={addLength}>
          Add length
        </Button>
      </View>
      <Text variant="caption">These show first in the length picker. Any length from 1 to 100 can still be typed.</Text>

      <SectionLabel>Made by</SectionLabel>
      <Group>
        {allCompanies.map((c) => (
          <ChoiceRow
            key={c.id}
            kind="checkbox"
            title={c.name}
            detail={c.active ? c.code : `${c.code} · inactive`}
            checked={d.companyIds.includes(c.id)}
            onPress={() => patch({ companyIds: d.companyIds.includes(c.id) ? d.companyIds.filter((x) => x !== c.id) : [...d.companyIds, c.id] })}
          />
        ))}
      </Group>
      {errors.companyIds ? <FormMessage>{errors.companyIds}</FormMessage> : null}

      {product ? (
        <Group>
          <Row>
            <View style={styles.fill}>
              <Text weight="medium">Active</Text>
              <Text variant="caption">Inactive products are hidden from new orders</Text>
            </View>
            <Switch label="Active" value={d.active} onChange={(active) => patch({ active })} disabled={busy} />
          </Row>
        </Group>
      ) : null}

      <ConfirmSheet
        visible={confirmDelete && !inUse}
        title={`Delete ${base?.displayName ?? 'product'}?`}
        body="It is removed from the product list for every company."
        confirmLabel="Delete forever"
        danger
        busy={del.isPending}
        onConfirm={() => void remove()}
        onCancel={() => setConfirmDelete(false)}
      />
      <ConfirmSheet
        visible={inUse}
        title="Make it inactive instead?"
        body={`${base?.displayName ?? 'This product'} is on orders, so it can’t be deleted. Inactive products stay on old orders but are hidden from new ones.`}
        confirmLabel="Make inactive"
        busy={update.isPending}
        onConfirm={() => void makeInactive()}
        onCancel={() => {
          setInUse(false);
          setConfirmDelete(false);
        }}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'flex-end', gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  footer: { flexDirection: 'row', gap: 10 },
});
