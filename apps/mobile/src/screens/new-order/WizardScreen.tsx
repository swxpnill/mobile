import {
  type Order,
  type PartySummary,
  type Product,
  can,
  formatLength,
  formatRupees,
  parseRateInput,
  toDisplayQty,
  toDisplayRate,
  unitLabel,
} from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { z } from 'zod';
import { ApiError } from '../../api/client';
import { byCode, useCompanies, usePlants } from '../../api/hooks/companies';
import { useParty, useProducts } from '../../api/hooks/masters';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { useCreateOrder, useDraft, useOrder, useUpdateOrder } from '../../api/hooks/orders';
import { useTenantSettings } from '../../api/hooks/settings';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { useDiscardGuard } from '../../nav/discardGuard';
import { useTheme } from '../../theme/ThemeProvider';
import {
  Button,
  ChoiceRow,
  ConfirmSheet,
  EmptyState,
  Group,
  Icon,
  IconButton,
  Row,
  Screen,
  SectionLabel,
  SegmentedControl,
  showToast,
  Switch,
  Text,
  TextField,
  UnitTag,
} from '../../ui';
import { MSG, messageFor } from '../messages';
import { AddLineSheet } from './AddLineSheet';
import { PartyPickerSheet } from './PartyPickerSheet';
import { useDraftAutosave } from './useDraftAutosave';
import {
  type LineDraft,
  type WizardState,
  emptyWizard,
  fromCreateBody,
  fromOrder,
  fromPayload,
  hasBroker,
  hasCustomer,
  itemsProblem,
  partiesProblem,
  preview,
  toCreateBody,
  toUpdateBody,
} from './wizard';

/**
 * The 3-step order wizard (canvas 07–10): new order, a resumed or duplicated draft
 * (`draftId`), or editing an order (`orderId`). The route decides; this screen loads what it
 * needs, then hands a ready state to the form.
 */
export function WizardScreen({
  draftId,
  orderId,
  partyId,
  inTab = false,
}: {
  draftId?: string;
  orderId?: string;
  partyId?: string;
  /** The New tab: after Create it opens the order and starts a fresh form. */
  inTab?: boolean;
}) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const { data: settings } = useTenantSettings();
  const draft = useDraft(draftId);
  const order = useOrder(orderId);
  const party = useParty(partyId);
  const [run, setRun] = useState(0);

  const initial = useMemo((): { state: WizardState; draft: { id: string; version: number } | null } | null => {
    if (!me || !settings) return null;
    if (orderId) return order.data ? { state: fromOrder(order.data, basis), draft: null } : null;
    if (draftId) {
      if (!draft.data) return null;
      const s = fromPayload(draft.data.payload) ?? fromCreateBody(draft.data.payload, basis);
      return { state: s ?? emptyWizard(settings.defaultPricing), draft: { id: draft.data.id, version: draft.data.version } };
    }
    const fresh = emptyWizard(settings.defaultPricing);
    if (partyId) {
      // "New order" from a customer or broker page starts with them chosen.
      if (!party.data) return null;
      const p = party.data;
      const commission =
        p.defaultCommissionPerMt !== null && p.defaultCommissionPerMt !== undefined
          ? toDisplayRate(p.defaultCommissionPerMt, basis).replace('₹', '').replace(/,/g, '')
          : '';
      return {
        state: p.type === 'broker' ? { ...fresh, type: 'broker_only', brokerId: p.id, commission } : { ...fresh, customerId: p.id },
        draft: null,
      };
    }
    return { state: fresh, draft: null };
    // Seed once per record; later refetches must not reset what is being typed.
  }, [Boolean(me), Boolean(settings), order.data?.id, draft.data?.id, party.data?.id, run]);

  const failed = (orderId && order.isError) || (draftId && draft.isError) || (partyId && party.isError);
  if (!initial) {
    return (
      <Screen header={<View style={styles.top} />}>
        {failed ? (
          <EmptyState icon="orders" title="Not found" body={MSG.notFound} />
        ) : (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        )}
      </Screen>
    );
  }
  return (
    <Wizard
      key={`${orderId ?? draftId ?? partyId ?? 'new'}:${run}`}
      initial={initial.state}
      initialDraft={initial.draft}
      order={order.data}
      inTab={inTab}
      onFinished={() => setRun((n) => n + 1)}
      onReload={async () => {
        await order.refetch();
        setRun((n) => n + 1);
      }}
    />
  );
}

const STEP_TITLE = { 1: 'Parties', 2: 'Items & pricing', 3: 'Review' } as const;

function Wizard({
  initial,
  initialDraft,
  order,
  inTab,
  onFinished,
  onReload,
}: {
  initial: WizardState;
  initialDraft: { id: string; version: number } | null;
  order?: Order;
  inTab: boolean;
  onFinished(): void;
  /** Edit mode: fetch the order again and start over from it (after STALE). */
  onReload(): Promise<void>;
}) {
  const router = useRouter();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  const [s, setS] = useState<WizardState>(initial);
  const [error, setError] = useState<string>();
  const [lineErrors, setLineErrors] = useState<Record<string, string>>({});
  const [leave, setLeave] = useState(false);
  const isEdit = s.mode === 'edit';
  const isOwner = me ? can(me.role, 'order.editDispatched') : false;
  const touched = useRef(false);
  const update = (c: Partial<WizardState> | ((x: WizardState) => WizardState)) => {
    touched.current = true;
    setS((x) => (typeof c === 'function' ? c(x) : { ...x, ...c }));
  };

  const autosave = useDraftAutosave({ state: s, enabled: !isEdit && touched.current, initialDraft, onReplaced: (next) => { setS(next); showToast('This draft was changed on another phone. Showing the latest.'); } });
  const guard = useDiscardGuard(isEdit && touched.current);
  const submitKey = useSubmitKey();
  const once = useSingleFlight();
  const create = useCreateOrder();
  const save = useUpdateOrder();

  const go = (step: 1 | 2 | 3) => setS((x) => ({ ...x, step }));
  const problem = s.step === 1 ? partiesProblem(s) : s.step === 2 ? itemsProblem(s) : null;

  const next = async () => {
    setError(undefined);
    if (problem) return setError(problem);
    if (s.step < 3) return go((s.step + 1) as 2 | 3);
    if (isEdit) return submitEdit();
    return submitCreate();
  };

  const mapServerError = (e: unknown) => {
    if (e instanceof ApiError) {
      const d = z.object({ lineId: z.string() }).safeParse(e.details);
      const loc = z.object({ subOrderIndex: z.number(), lineIndex: z.number().optional() }).safeParse(e.details);
      const msg = messageFor(e);
      if (d.success) {
        s.subOrders.forEach((sub, si) => sub.lines.forEach((l, li) => {
          if (l.id === d.data.lineId) setLineErrors({ [`${si}.${li}`]: msg });
        }));
      } else if (loc.success && loc.data.lineIndex !== undefined) {
        setLineErrors({ [`${loc.data.subOrderIndex}.${loc.data.lineIndex}`]: msg });
      }
      if (e.code === 'STALE' && isEdit) {
        // Their change wins; reopen the editor on the latest order (the old version can never save).
        showToast(MSG.stale);
        void onReload();
        return;
      }
      setError(e.code === 'VALIDATION' ? 'Some values are not valid. Check the marked lines.' : msg);
    } else setError(messageFor(e));
  };

  const submitCreate = async () => {
    const draftId = await autosave.saveNow().catch(() => autosave.draftId);
    const built = toCreateBody(s, basis, draftId);
    if (!built.ok) {
      setError(Object.values(built.errors)[0]);
      return;
    }
    const expected = preview(s, basis, productsById).totalValue;
    try {
      const o = await create.mutateAsync({ body: built.body, key: submitKey.key() });
      submitKey.settle();
      showToast(o.estimatedValue !== undefined && o.estimatedValue !== expected ? `${o.number} created · value from the server: ${formatRupees(o.estimatedValue)}` : `${o.number} created`);
      if (inTab) {
        router.push(`/orders/${o.id}`);
        onFinished();
      } else router.replace(`/orders/${o.id}`);
    } catch (e) {
      submitKey.settle(e);
      mapServerError(e);
    }
  };

  const submitEdit = async () => {
    const built = toUpdateBody(s, basis);
    if (!built.ok || !s.orderId) {
      if (!built.ok) setError(Object.values(built.errors)[0]);
      return;
    }
    try {
      const o = await save.mutateAsync({ id: s.orderId, body: built.body });
      showToast(o.warnings?.length ? 'Saved · some lines are now below what is planned on trucks' : 'Saved');
      guard.allow();
      router.back();
    } catch (e) {
      mapServerError(e);
    }
  };

  // Product conversions for the preview (products made by any company).
  const { data: products } = useProducts({ active: true });
  const productsById = useMemo(() => new Map((products ?? []).map((p) => [p.id, p])), [products]);
  const pv = preview(s, basis, productsById);

  /** Leave the wizard: the tab resets to a blank form; a pushed wizard goes back. */
  const exit = () => {
    if (inTab) {
      onFinished();
      router.navigate('/orders');
    } else router.back();
  };
  const close = () => {
    if (isEdit || !touched.current) return exit();
    setLeave(true);
  };

  const busy = create.isPending || save.isPending;
  const primary = s.step < 3 ? 'Continue' : isEdit ? 'Save changes' : 'Create order';

  return (
    <Screen
      keyboard
      header={
        <View style={styles.top}>
          <IconButton icon={s.step === 1 ? 'close' : 'back'} label={s.step === 1 ? 'Close' : 'Back'} onPress={() => (s.step === 1 ? close() : go((s.step - 1) as 1 | 2))} />
          <Text weight="medium" style={styles.fill}>
            {isEdit ? `Edit ${order?.number ?? 'order'}` : 'New order'}
          </Text>
          {!isEdit ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Save draft"
              hitSlop={10}
              onPress={() =>
                void once(async () => {
                  touched.current = true;
                  const id = await autosave.saveNow();
                  showToast(id ? 'Draft saved' : 'Couldn’t save the draft');
                  if (id) exit();
                })
              }
              style={styles.saveDraft}
            >
              <Text weight="medium" color="brt">
                Save draft
              </Text>
            </Pressable>
          ) : null}
        </View>
      }
      footer={
        <>
          {s.step === 2 ? (
            <View style={styles.totals} accessible accessibilityLabel={`${toDisplayQty(pv.totalKg, basis, { withUnit: true })}, ${pv.lineCount} lines, ${formatRupees(pv.totalValue)} before GST`}>
              <Text variant="caption" style={styles.fill}>{`${toDisplayQty(pv.totalKg, basis, { withUnit: true })} · ${pv.lineCount} ${pv.lineCount === 1 ? 'line' : 'lines'} · before GST`}</Text>
              <Text weight="semibold" numeric>
                {formatRupees(pv.totalValue)}
              </Text>
            </View>
          ) : null}
          {error ? (
            <Text color="dgt" accessibilityRole="alert">
              {error}
            </Text>
          ) : null}
          <Button onPress={() => void once(next)} loading={busy}>
            {primary}
          </Button>
        </>
      }
    >
      {guard.sheet}
      <Text variant="caption" weight="medium">{`Step ${s.step} of 3 · ${STEP_TITLE[s.step]}`}</Text>
      {s.step === 1 ? <PartiesStep s={s} update={update} /> : null}
      {s.step === 2 ? (
        <ItemsStep s={s} update={update} products={products ?? []} preview={pv} order={order} isOwner={isOwner} lineErrors={lineErrors} />
      ) : null}
      {s.step === 3 ? <ReviewStep s={s} update={update} preview={pv} /> : null}
      <ConfirmSheet
        visible={leave}
        title="Keep this draft?"
        body="It is saved for 7 days. Find it under Drafts on the Orders tab."
        confirmLabel="Keep draft"
        cancelLabel="Discard draft"
        onConfirm={() =>
          void (async () => {
            setLeave(false);
            await autosave.saveNow();
            exit();
          })()
        }
        onCancel={() =>
          void (async () => {
            setLeave(false);
            await autosave.forget();
            exit();
          })()
        }
      />
      <Text variant="caption" style={styles.status}>
        {autosave.status === 'saving' ? 'Saving draft…' : autosave.status === 'saved' ? 'Draft saved' : ''}
      </Text>
    </Screen>
  );
}

type Update = (c: Partial<WizardState> | ((x: WizardState) => WizardState)) => void;

function PartiesStep({ s, update }: { s: WizardState; update: Update }) {
  const basis = useDisplayBasis();
  const [pick, setPick] = useState<'customer' | 'broker' | null>(null);
  const customer = useParty(s.customerId ?? undefined);
  const broker = useParty(s.brokerId ?? undefined);
  const unit = unitLabel(basis);
  const ships = (customer.data?.addresses ?? []).filter((a) => a.kind === 'ship_to');

  const choose = (p: PartySummary) => {
    if (pick === 'customer') update({ customerId: p.id, billToId: null, shipToId: null });
    if (pick === 'broker') {
      update({
        brokerId: p.id,
        commission:
          p.defaultCommissionPerMt !== null && p.defaultCommissionPerMt !== undefined
            ? toDisplayRate(p.defaultCommissionPerMt, basis).replace('₹', '').replace(/,/g, '')
            : s.commission,
      });
    }
    setPick(null);
  };

  // Bill-to is the customer's one bill-to; ship-to defaults to their default site.
  useEffect(() => {
    const c = customer.data;
    if (!c || c.id !== s.customerId) return;
    const bill = c.addresses.find((a) => a.kind === 'bill_to');
    const def = c.addresses.find((a) => a.kind === 'ship_to' && a.isDefault) ?? c.addresses.find((a) => a.kind === 'ship_to');
    if (bill && s.billToId !== bill.id) update((x) => ({ ...x, billToId: bill.id }));
    if (def && !s.shipToId) update((x) => ({ ...x, shipToId: def.id }));
  }, [customer.data?.id, s.customerId]);

  const pickerRow = (kind: 'customer' | 'broker', name: string | undefined, detail: string | undefined) => (
    <Group>
      <Row onPress={() => setPick(kind)} accessibilityLabel={name ? `Change ${kind}: ${name}` : `Choose ${kind}`}>
        <View style={styles.fill}>
          <Text variant="caption">{kind === 'customer' ? 'Customer' : 'Broker'}</Text>
          <Text weight="medium" color={name ? 'tx' : 'brt'}>
            {name ?? `Choose ${kind}`}
          </Text>
          {detail ? <Text variant="caption">{detail}</Text> : null}
        </View>
        <Icon name="chevronRight" size={18} color="#888" />
      </Row>
    </Group>
  );

  return (
    <>
      <Text variant="title" accessibilityRole="header">
        Who is this order for?
      </Text>
      <Text variant="caption" weight="medium">
        Order type
      </Text>
      <SegmentedControl
        size="full"
        accessibilityLabel="Order type"
        value={s.type}
        onChange={(type: WizardState['type']) => update({ type })}
        options={[
          { value: 'customer_broker', label: 'Customer + broker' },
          { value: 'customer', label: 'Customer' },
          { value: 'broker_only', label: 'Broker only' },
        ]}
      />
      {hasCustomer(s.type) ? pickerRow('customer', customer.data?.name, customer.data ? [customer.data.city, customer.data.gstin ? `GSTIN ${customer.data.gstin}` : null].filter(Boolean).join(' · ') : undefined) : null}
      {hasBroker(s.type) ? (
        <>
          {pickerRow('broker', broker.data?.name, broker.data?.city)}
          <TextField
            label="Broker commission"
            prefix="₹"
            value={s.commission}
            onChangeText={(commission) => update({ commission })}
            hint={`Per ${unit}. Filled from the broker’s profile. Changes apply to this order only.`}
            keyboardType="decimal-pad"
            maxLength={12}
          />
        </>
      ) : null}
      {hasCustomer(s.type) && customer.data ? (
        <>
          <SectionLabel>Bill to</SectionLabel>
          <Group>
            <Row>
              <View style={styles.fill}>
                <Text weight="medium">{customer.data.name}</Text>
                <Text variant="caption">{customer.data.addresses.find((a) => a.kind === 'bill_to')?.address ?? 'No bill-to address — add one in Customers'}</Text>
              </View>
            </Row>
          </Group>
          <SectionLabel>{`Ship to · ${ships.length}`}</SectionLabel>
          <Group>
            {ships.map((a) => (
              <ChoiceRow key={a.id} kind="radio" title={a.label} detail={a.address} checked={s.shipToId === a.id} onPress={() => update({ shipToId: a.id })} />
            ))}
          </Group>
        </>
      ) : null}
      <PartyPickerSheet type={pick ?? 'customer'} visible={pick !== null} onPick={choose} onClose={() => setPick(null)} />
    </>
  );
}

function ItemsStep({
  s,
  update,
  products,
  preview: pv,
  order,
  isOwner,
  lineErrors,
}: {
  s: WizardState;
  update: Update;
  products: Product[];
  preview: ReturnType<typeof preview>;
  order?: Order;
  isOwner: boolean;
  lineErrors: Record<string, string>;
}) {
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const { data: companies } = useCompanies();
  const { data: plants } = usePlants();
  const [editing, setEditing] = useState<{ si: number; li: number | null } | null>(null);
  const [addingCompany, setAddingCompany] = useState(false);
  const all = byCode(companies ?? []);
  const unit = unitLabel(basis);
  const used = new Set(s.subOrders.map((x) => x.companyId));
  const free = all.filter((c) => c.active && !used.has(c.id));
  const basic = parseRateInput(s.basicRate, basis);
  const brokerName = hasBroker(s.type) ? 'the broker' : null;
  const dispatchedById = new Map(order?.subOrders.flatMap((x) => x.lines.map((l) => [l.id, l.dispatchedKg] as const)) ?? []);

  const saveLine = (si: number, li: number | null, line: LineDraft) =>
    update((x) => ({
      ...x,
      subOrders: x.subOrders.map((sub, i) =>
        i !== si ? sub : { ...sub, lines: li === null ? [...sub.lines, line] : sub.lines.map((l, j) => (j === li ? line : l)) },
      ),
    }));

  const current = editing ? s.subOrders[editing.si] : undefined;
  const currentLine = editing && editing.li !== null ? current?.lines[editing.li] : undefined;
  const dispatched = currentLine?.id ? (dispatchedById.get(currentLine.id) ?? 0) : 0;

  return (
    <>
      <Text variant="caption" weight="medium">
        Pricing
      </Text>
      <SegmentedControl
        size="full"
        accessibilityLabel="Pricing method"
        value={s.pricingMethod}
        onChange={(pricingMethod: WizardState['pricingMethod']) => update({ pricingMethod })}
        options={[
          { value: 'direct', label: 'Direct rate' },
          { value: 'basic_conversion', label: 'Basic + conversion' },
        ]}
      />
      {s.pricingMethod === 'basic_conversion' ? (
        <TextField
          label={`Basic rate per ${unit}, before GST`}
          prefix="₹"
          value={s.basicRate}
          onChangeText={(basicRate) => update({ basicRate })}
          keyboardType="decimal-pad"
          maxLength={12}
        />
      ) : null}

      {s.subOrders.map((sub, si) => {
        const co = all.find((c) => c.id === sub.companyId);
        const where = (plants ?? []).filter((p) => p.companyId === sub.companyId && p.active).map((p) => p.name).join(', ');
        const totals = pv.perSub[si];
        return (
          <View key={sub.companyId} style={styles.section}>
            <View style={styles.inline}>
              <View style={styles.fill}>
                <View style={styles.inline}>
                  <Text variant="heading" numberOfLines={1}>
                    {co?.name ?? 'Company'}
                  </Text>
                  {co ? <UnitTag code={co.code} slot={all.indexOf(co)} /> : null}
                </View>
                <Text variant="caption">{`${where || 'No plant'} · billed separately`}</Text>
              </View>
              <View style={styles.right}>
                <Text weight="semibold" numeric>
                  {formatRupees(totals?.value ?? 0)}
                </Text>
                <Text variant="caption">{toDisplayQty(totals?.kg ?? 0, basis, { withUnit: true })}</Text>
              </View>
            </View>
            <Group>
              {sub.lines.map((l, li) => {
                const p = products.find((x) => x.id === l.productId);
                const line = pv.lines.find((x) => x.si === si && x.li === li);
                const err = lineErrors[`${si}.${li}`];
                return (
                  <Row key={l.key} onPress={() => setEditing({ si, li })} accessibilityLabel={`${p?.displayName ?? 'Product'} ${formatLength(l.length)}, ${l.qty || '0'} ${unit}${err ? `, ${err}` : ''}`}>
                    <View style={styles.fill}>
                      <Text weight="medium" numberOfLines={1}>
                        {p?.displayName ?? 'Product'}
                      </Text>
                      <Text variant="caption" numberOfLines={1}>
                        {[
                          formatLength(l.length),
                          line?.rate !== null && line?.rate !== undefined ? toDisplayRate(line.rate, basis) : null,
                          l.overprice ? `+${l.overprice} broker` : null,
                          l.rate && s.pricingMethod === 'basic_conversion' ? 'Rate edited' : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                      {err ? (
                        <Text variant="caption" color="dgt">
                          {err}
                        </Text>
                      ) : null}
                    </View>
                    <View style={styles.right}>
                      <Text weight="medium" numeric>{`${l.qty || '0'} ${unit}`}</Text>
                      <Text variant="caption" numeric>
                        {line?.value !== null && line?.value !== undefined ? formatRupees(line.value) : '—'}
                      </Text>
                    </View>
                  </Row>
                );
              })}
              <Row onPress={() => setEditing({ si, li: null })} accessibilityLabel={`Add line to ${co?.name ?? 'company'}`}>
                <Icon name="plus" size={20} color={t.brt} />
                <Text weight="medium" color="brt" style={styles.fill}>
                  Add line
                </Text>
              </Row>
            </Group>
          </View>
        );
      })}

      {free.length > 0 ? (
        <Group>
          <Row onPress={() => setAddingCompany((x) => !x)} accessibilityLabel={s.subOrders.length === 0 ? 'Choose the company' : 'Split with another unit'}>
            <Icon name="factory" size={20} color={t.brt} />
            <View style={styles.fill}>
              <Text weight="medium" color="brt">
                {s.subOrders.length === 0 ? 'Choose the company' : 'Split with another unit'}
              </Text>
              <Text variant="caption">{free.map((c) => short(c.name)).join(' · ')}</Text>
            </View>
          </Row>
          {addingCompany
            ? free.map((c) => (
                <ChoiceRow
                  key={c.id}
                  kind="radio"
                  title={c.name}
                  detail={c.code}
                  checked={false}
                  onPress={() => {
                    setAddingCompany(false);
                    update((x) => ({ ...x, subOrders: [...x.subOrders, { companyId: c.id, lines: [] }] }));
                    setEditing({ si: s.subOrders.length, li: null });
                  }}
                />
              ))
            : null}
        </Group>
      ) : null}

      {editing && current ? (
        <AddLineSheet
          visible
          companyName={all.find((c) => c.id === current.companyId)?.name ?? ''}
          products={products.filter((p) => p.active && p.companyIds.includes(current.companyId))}
          pricingMethod={s.pricingMethod}
          basicRate={basic.ok ? basic.value : null}
          brokerName={brokerName}
          commissionText={s.commission ? `₹${s.commission}` : ''}
          initial={currentLine ?? null}
          locked={
            dispatched > 0
              ? isOwner
                ? undefined
                : { minKg: dispatched, reason: `At least ${toDisplayQty(dispatched, basis, { withUnit: true })} (already dispatched)` }
              : undefined
          }
          onSave={(line, another) => {
            saveLine(editing.si, editing.li, line);
            if (!another) setEditing(null);
            else setEditing({ si: editing.si, li: null });
          }}
          onRemove={
            editing.li !== null
              ? () => {
                  const { si, li } = editing;
                  update((x) => ({
                    ...x,
                    subOrders: x.subOrders
                      .map((sub, i) => (i !== si ? sub : { ...sub, lines: sub.lines.filter((_, j) => j !== li) }))
                      .filter((sub) => sub.lines.length > 0 || sub.id !== undefined),
                  }));
                  setEditing(null);
                }
              : undefined
          }
          onClose={() => {
            // A company added with no line yet is dropped again.
            update((x) => ({ ...x, subOrders: x.subOrders.filter((sub) => sub.lines.length > 0 || sub.id !== undefined) }));
            setEditing(null);
          }}
        />
      ) : null}
    </>
  );
}

const short = (name: string) => name.split(/\s+/).slice(0, 2).join(' ');

function ReviewStep({ s, update, preview: pv }: { s: WizardState; update: Update; preview: ReturnType<typeof preview> }) {
  const basis = useDisplayBasis();
  const { data: companies } = useCompanies();
  const customer = useParty(s.customerId ?? undefined);
  const broker = useParty(s.brokerId ?? undefined);
  const all = byCode(companies ?? []);
  const ship = customer.data?.addresses.find((a) => a.id === s.shipToId);
  const q = (kg: number) => toDisplayQty(kg, basis, { withUnit: true });
  const subs = s.subOrders.filter((x) => x.lines.length > 0);
  return (
    <>
      <Group>
        <View style={styles.card}>
          <Text variant="caption">Order value, before GST</Text>
          <Text weight="semibold" numeric style={styles.big}>
            {formatRupees(pv.totalValue)}
          </Text>
          <Text variant="caption">{`${q(pv.totalKg)} · ${pv.lineCount} ${pv.lineCount === 1 ? 'line' : 'lines'} · ${subs.length} ${subs.length === 1 ? 'unit' : 'units'}`}</Text>
        </View>
      </Group>
      <Group>
        {hasCustomer(s.type) ? (
          <Row>
            <Text variant="caption" style={styles.label}>
              Customer
            </Text>
            <Text style={styles.fill}>{customer.data ? `${customer.data.name}, ${customer.data.city}` : '—'}</Text>
          </Row>
        ) : null}
        {hasBroker(s.type) ? (
          <Row>
            <Text variant="caption" style={styles.label}>
              Broker
            </Text>
            <Text style={styles.fill}>{broker.data ? `${broker.data.name} · ₹${s.commission} / ${unitLabel(basis)}` : '—'}</Text>
          </Row>
        ) : null}
        {ship ? (
          <Row>
            <Text variant="caption" style={styles.label}>
              Ship to
            </Text>
            <Text style={styles.fill}>{`${ship.label}, ${ship.address}`}</Text>
          </Row>
        ) : null}
      </Group>
      <SectionLabel>{`${subs.length} ${subs.length === 1 ? 'sub-order' : 'sub-orders'} · each company bills separately`}</SectionLabel>
      <Group>
        {s.subOrders.map((sub, si) => {
          const co = all.find((c) => c.id === sub.companyId);
          if (!co || sub.lines.length === 0) return null;
          return (
            <Row key={sub.companyId}>
              <UnitTag code={co.code} slot={all.indexOf(co)} />
              <View style={styles.fill}>
                <Text weight="medium">{co.name}</Text>
                <Text variant="caption">{`${sub.lines.length} ${sub.lines.length === 1 ? 'line' : 'lines'} · ${q(pv.perSub[si]?.kg ?? 0)}`}</Text>
              </View>
              <Text weight="medium" numeric>
                {formatRupees(pv.perSub[si]?.value ?? 0)}
              </Text>
            </Row>
          );
        })}
      </Group>
      {pv.broker ? (
        <>
          <SectionLabel>Broker earning · estimate</SectionLabel>
          <Group>
            <Row>
              <Text style={styles.fill}>{`Commission · ${q(pv.broker.commissionKg)}`}</Text>
              <Text numeric>{formatRupees(pv.broker.commission)}</Text>
            </Row>
            {pv.broker.overpriceKg > 0 ? (
              <Row>
                <Text style={styles.fill}>{`Overprice · ${q(pv.broker.overpriceKg)}`}</Text>
                <Text numeric>{formatRupees(pv.broker.overprice)}</Text>
              </Row>
            ) : null}
            <Row>
              <Text weight="semibold" style={styles.fill}>
                Total
              </Text>
              <Text weight="semibold" numeric>
                {formatRupees(pv.broker.total)}
              </Text>
            </Row>
          </Group>
          <Text variant="caption">Final amount is worked out on each truck’s net weight.</Text>
        </>
      ) : null}
      <Group>
        {hasCustomer(s.type) ? (
          <Row>
            <Text style={styles.fill}>WhatsApp confirmation to customer</Text>
            <Switch label="WhatsApp confirmation to customer" value={s.notify.customer} onChange={(customer) => update((x) => ({ ...x, notify: { ...x.notify, customer } }))} />
          </Row>
        ) : null}
        {hasBroker(s.type) ? (
          <Row>
            <Text style={styles.fill}>WhatsApp confirmation to broker</Text>
            <Switch label="WhatsApp confirmation to broker" value={s.notify.broker} onChange={(broker) => update((x) => ({ ...x, notify: { ...x.notify, broker } }))} />
          </Row>
        ) : null}
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  top: { flexDirection: 'row', alignItems: 'center', gap: 4, paddingHorizontal: 8, paddingTop: 8, minHeight: 52 },
  saveDraft: { paddingHorizontal: 12, minHeight: 44, justifyContent: 'center' },
  fill: { flex: 1, minWidth: 0 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  right: { alignItems: 'flex-end' },
  section: { gap: 10 },
  totals: { flexDirection: 'row', alignItems: 'center' },
  card: { padding: 20, gap: 4 },
  big: { fontSize: 32, lineHeight: 38 },
  label: { width: 72 },
  status: { textAlign: 'center' },
});
