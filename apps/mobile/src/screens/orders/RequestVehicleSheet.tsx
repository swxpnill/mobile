import {
  type Order,
  type Party,
  type Plant,
  type VehicleRequest,
  type VehicleRequestBody,
  buildRequestMessage,
  can,
  defaultRecipient,
  formatLength,
  formatMobile,
  isTerminal,
  isWhatsAppNumber,
  normalizeIndianMobile,
  toDisplayQty,
  unitLabel,
} from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useReducer, useState } from 'react';
import { Linking, ScrollView, StyleSheet, TextInput, View } from 'react-native';
import { byCode, useCompanies, usePlants } from '../../api/hooks/companies';
import { useParty } from '../../api/hooks/masters';
import { useDisplayBasis, useMe } from '../../api/hooks/me';
import { useTenantSettings } from '../../api/hooks/settings';
import { useRequestVehicle } from '../../api/hooks/vehicleRequests';
import { useSingleFlight } from '../../api/submitKey';
import { copyText } from '../../format/clipboard';
import { dialLink, whatsappLink } from '../../format/contactLinks';
import { useTheme } from '../../theme/ThemeProvider';
import { fontFamily } from '../../theme/tokens';
import { Button, Group, IconButton, SegmentedControl, showToast, Text } from '../../ui';
import { inputTheme } from '../../ui/inputTheme';
import { Sheet } from '../../ui/Sheet';
import { messageFor } from '../messages';
import {
  LineSummaryRow,
  LinkButton,
  NumberRow,
  PickLineRow,
  PlainRow,
  SubOrderRow,
  TotalRow,
} from './requestVehicleParts';
import {
  type RvLine,
  type RvMaterial,
  type RvRecipient,
  initRequestState,
  requestVehicleReducer,
  selection,
  totalKg,
} from './requestVehicleState';

type Props = { order: Order; visible: boolean; onClose(): void; prefill?: VehicleRequest };

/**
 * Canvas board 40: ask the order's broker or customer for a truck, by WhatsApp or a call, with a
 * prefilled message. The request is recorded when the call or chat opens (Ruling 8). Every opening
 * starts fresh (or from `prefill`, an open request). The sheet stays mounted when it closes, so
 * its Modal slides (or fades) out; a new opening is a new body.
 */
export function RequestVehicleSheet(props: Props) {
  const [opened, setOpened] = useState(props.visible ? 1 : 0);
  const [wasVisible, setWasVisible] = useState(props.visible);
  if (props.visible !== wasVisible) {
    setWasVisible(props.visible);
    if (props.visible) setOpened((n) => n + 1);
  }
  return <RequestVehicleBody key={`${opened}:${props.prefill?.id ?? ''}`} {...props} />;
}

const firstWord = (s: string) => s.trim().split(/\s+/)[0] ?? s;
/** "+91 98261 00501" for a mobile, "+91 712 255 1234" for a landline. */
const shownNumber = (n: string) => {
  const mobile = normalizeIndianMobile(n);
  if (mobile) return formatMobile(mobile);
  const m = /^\+91(\d{3})(\d{3})(\d{4})$/.exec(n);
  return m ? `+91 ${m[1]} ${m[2]} ${m[3]}` : n;
};
/** "TMT Fe500D · 12 mm" → product "TMT Fe500D", size "12 mm" (the message's "TMT Fe500D 12 mm · 12 m"). */
export const splitProduct = (name: string) => {
  const [product = name, ...size] = name.split(' · ');
  return { product, size: size.join(' · ') };
};
const partyLabel = (p: { name: string; city: string }) => (p.city ? `${p.name}, ${p.city}` : p.name);
/** "AIP", "AIP or KRM", "AIP, KRM or VSL". */
const orList = (xs: string[]) => (xs.length <= 1 ? (xs[0] ?? '') : `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1]}`);

/** The party's first WhatsApp number, else its first number, else none saved. */
function pickNumber(party: Party): RvRecipient {
  const all = party.contacts.flatMap((c) => c.numbers.map((n) => ({ c, n })));
  const best = all.find(({ n }) => isWhatsAppNumber(n)) ?? all[0];
  return { partyId: party.id, contactId: best?.c.id ?? null, numberId: best?.n.id ?? null };
}

function RequestVehicleBody({ order, visible, onClose, prefill }: Props) {
  const { t, scheme, scale } = useTheme();
  const router = useRouter();
  const basis = useDisplayBasis();
  const { data: me } = useMe();
  // Nothing is fetched while the sheet is closed.
  const { data: settings } = useTenantSettings(visible);
  const { data: companies } = useCompanies(visible);
  const { data: plants } = usePlants(visible);
  const broker = useParty(order.broker?.id, visible);
  const customer = useParty(order.customer?.id, visible);
  const { send } = useRequestVehicle(order.id);
  const once = useSingleFlight();
  const [busy, setBusy] = useState<VehicleRequestBody['channel'] | null>(null);
  const external = settings?.externalUnitBasis ?? 'mt';
  const unit = unitLabel(basis);
  const q = (kg: number) => toDisplayQty(kg, basis, { withUnit: true });

  // The order's open lines with something pending, in order; with what each row shows.
  const rows = useMemo(
    () =>
      order.subOrders
        .filter((s) => !isTerminal(s.status))
        .flatMap((s) => s.lines.filter((l) => l.pendingKg > 0).map((l) => ({ s, l, name: `${l.productName} · ${formatLength(l.length)}` }))),
    [order],
  );
  const lines: RvLine[] = useMemo(() => rows.map(({ s, l }) => ({ id: l.id, subOrderId: s.id, pendingKg: l.pendingKg })), [rows]);
  const [state, dispatch] = useReducer(requestVehicleReducer, undefined, () => initRequestState(lines, prefill));

  const linesKey = JSON.stringify(lines);
  useEffect(() => {
    dispatch({ type: 'lines', lines });
    // linesKey stands for `lines`: a refetch with the same lines must not dispatch.
  }, [linesKey]);

  // The parties on the order, broker first (canvas), once loaded.
  const refs = [order.broker ? { ref: order.broker, kind: 'Broker' as const, q: broker } : null, order.customer ? { ref: order.customer, kind: 'Customer' as const, q: customer } : null].filter(
    (x): x is NonNullable<typeof x> => x !== null,
  );
  // Each party on its own: one that fails to load leaves the other usable.
  const statusOf = (r: (typeof refs)[number]): 'loading' | 'error' | 'loaded' =>
    r.q.data !== undefined ? 'loaded' : r.q.isError ? 'error' : 'loading';
  const settled = refs.every((r) => statusOf(r) !== 'loading');
  const parties: Record<string, Party> = Object.fromEntries(refs.flatMap((r) => (r.q.data ? [[r.ref.id, r.q.data]] : [])));

  // Who is asked first, once every party has loaded or failed: the open request's number, else the
  // broker's WhatsApp, else the customer's…; with none loaded, the first party (its error shows).
  useEffect(() => {
    if (state.recipient || !visible || !settled || refs.length === 0) return;
    const fromPrefill = (() => {
      const party = prefill ? parties[prefill.partyId] : undefined;
      for (const c of party?.contacts ?? []) {
        const n = c.numbers.find((x) => x.number === prefill?.number);
        if (party && n) return { partyId: party.id, contactId: c.id, numberId: n.id };
      }
      return null;
    })();
    const firstLoaded = refs.map((r) => parties[r.ref.id]).find((p): p is Party => p !== undefined);
    dispatch({
      type: 'recipient',
      recipient: fromPrefill ?? defaultRecipient(order, parties) ?? (firstLoaded ? pickNumber(firstLoaded) : { partyId: refs[0]!.ref.id, contactId: null, numberId: null }),
    });
  });

  const party = state.recipient ? parties[state.recipient.partyId] : undefined;
  const contact = party?.contacts.find((c) => c.id === state.recipient?.contactId);
  const number = contact?.numbers.find((n) => n.id === state.recipient?.numberId);
  const canWhatsApp = number ? isWhatsAppNumber(number) : false;

  const all = byCode(companies ?? []);
  const slot = (code: string) => Math.max(0, all.findIndex((c) => c.code === code));
  const plantOf = (companyId: string): string | null => {
    const active = (plants ?? []).filter((p: Plant) => p.companyId === companyId && p.active);
    return active.length === 1 ? active[0]!.name : null;
  };

  const chosen = selection(state);
  const total = totalKg(state);
  const orderParty = order.customer ?? order.broker;
  const composed = useMemo(() => {
    const kgOf = new Map(chosen.map((c) => [c.orderLineId, c.kg]));
    return buildRequestMessage({
      contactFirstName: firstWord(contact?.name ?? party?.name ?? ''),
      orderNo: order.number,
      party: orderParty ? partyLabel(orderParty) : '',
      lines: rows
        .filter(({ l }) => kgOf.has(l.id))
        .map(({ s, l }) => ({
          ...splitProduct(l.productName),
          length: formatLength(l.length),
          kg: kgOf.get(l.id)!,
          company: firstWord(s.companyName),
          plant: plantOf(s.companyId),
        })),
      senderFirstName: firstWord(me?.name ?? ''),
      basis: external,
    });
  }, [JSON.stringify(chosen), contact?.name, party?.name, order.number, orderParty, rows, me?.name, external, plants]);
  useEffect(() => dispatch({ type: 'compose', text: composed }), [composed]);

  const setMaterial = (m: RvMaterial) => dispatch({ type: 'material', material: m });
  const openSubs = order.subOrders.filter((s) => lines.some((l) => l.subOrderId === s.id));
  const nothing = lines.length === 0;

  const record = async (channel: VehicleRequestBody['channel']) => {
    if (!party || !contact || !number || total <= 0) return;
    const mobile = normalizeIndianMobile(number.number);
    const url = channel === 'whatsapp' ? (mobile && canWhatsApp ? whatsappLink(mobile, state.message) : null) : dialLink(number.number);
    if (!url) return;
    const usable = await Linking.canOpenURL(url).catch(() => false);
    if (!usable) {
      showToast(channel === 'whatsapp' ? "WhatsApp isn't installed" : "Can't place calls on this phone");
      return;
    }
    setBusy(channel);
    // Recorded as the app opens; the network never holds up the call or the chat.
    const sending = send({ partyId: party.id, contactName: contact.name, number: number.number, channel, lines: chosen, totalKg: total });
    Linking.openURL(url).catch(() => showToast(channel === 'whatsapp' ? "Couldn't open WhatsApp" : "Couldn't start a call on this phone"));
    try {
      const outcome = await sending;
      onClose();
      showToast(outcome === 'queued' ? 'Request saved · will send when online' : 'Request recorded');
    } catch (e) {
      showToast(messageFor(e));
    } finally {
      setBusy(null);
    }
  };

  const copy = () =>
    copyText(state.message).then(
      () => showToast('Copied'),
      () => showToast("Couldn't copy"),
    );

  const header = (
    <View style={styles.head}>
      <View style={styles.fill}>
        <Text variant="subtitle" accessibilityRole="header">
          Request vehicle
        </Text>
        <Text variant="caption" numberOfLines={1} style={styles.sub}>
          {orderParty ? `${order.number} · ${partyLabel(orderParty)}` : order.number}
        </Text>
      </View>
      <View style={[styles.close, { backgroundColor: t.ctl }]}>
        <IconButton icon="close" label="Close" onPress={() => (busy ? undefined : onClose())} />
      </View>
    </View>
  );

  // The party whose numbers show: nothing (Loading numbers…) until the first recipient is chosen,
  // so "No number saved" never flashes before it.
  const shown = state.recipient ? refs.find((r) => r.ref.id === state.recipient?.partyId) : undefined;
  const shownStatus = shown ? statusOf(shown) : 'loading';
  const mayAddNumber = me ? can(me.role, 'masters.manage') : false;
  const numbers = party?.contacts.flatMap((c) => c.numbers.map((n) => ({ c, n }))) ?? [];

  return (
    <Sheet visible={visible} title="Request vehicle" header={header} onClose={onClose} busy={busy !== null}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.body} showsVerticalScrollIndicator={false}>
        <View style={styles.section}>
          <Text variant="overline">Send to</Text>
          {refs.length > 1 ? (
            <SegmentedControl
              size="full"
              accessibilityLabel="Party"
              value={state.recipient?.partyId ?? refs[0]!.ref.id}
              onChange={(id) => {
                const p = parties[id];
                dispatch({ type: 'recipient', recipient: p ? pickNumber(p) : { partyId: id, contactId: null, numberId: null } });
              }}
              options={refs.map((r) => ({ value: r.ref.id, label: r.ref.name, detail: r.kind, detailColor: r.kind === 'Broker' ? 'vi' : undefined }))}
            />
          ) : refs[0] ? (
            <Group>
              <PlainRow>
                <View style={styles.fill}>
                  <Text weight="medium">{refs[0].ref.name}</Text>
                  <Text variant="caption" color={refs[0].kind === 'Broker' ? 'vi' : 'tx3'}>
                    {refs[0].kind}
                  </Text>
                </View>
              </PlainRow>
            </Group>
          ) : null}
          {!shown || shownStatus === 'loading' ? (
            <Group>
              <PlainRow>
                <Text color="tx3" accessibilityLiveRegion="polite">
                  Loading numbers…
                </Text>
              </PlainRow>
            </Group>
          ) : shownStatus === 'error' ? (
            <Group>
              <PlainRow>
                <Text color="tx2" style={styles.fill} accessibilityRole="alert">
                  {`Couldn't load ${shown.ref.name}'s numbers`}
                </Text>
                <LinkButton label="Try again" onPress={() => void shown.q.refetch()} />
              </PlainRow>
            </Group>
          ) : numbers.length === 0 ? (
            <Group>
              <PlainRow>
                <Text color="tx2" style={styles.fill}>
                  No number saved
                </Text>
                {mayAddNumber && party ? (
                  <LinkButton
                    label="Add a number"
                    onPress={() => {
                      onClose();
                      router.push(`/parties/form?id=${party.id}`);
                    }}
                  />
                ) : null}
              </PlainRow>
            </Group>
          ) : (
            <View accessibilityRole="radiogroup" accessibilityLabel="Number">
              <Group>
                {numbers.map(({ c, n }) => (
                  <NumberRow
                    key={n.id}
                    title={c.name}
                    label={c.numbers.length > 1 ? n.label : c.roleLabel}
                    number={shownNumber(n.number)}
                    whatsapp={isWhatsAppNumber(n)}
                    checked={n.id === number?.id}
                    onPress={() => dispatch({ type: 'recipient', recipient: { partyId: party!.id, contactId: c.id, numberId: n.id } })}
                  />
                ))}
              </Group>
            </View>
          )}
        </View>

        <View style={styles.section}>
          <Text variant="overline">Material</Text>
          {nothing ? (
            <Group>
              <PlainRow>
                <Text color="tx2">Nothing pending on this order</Text>
              </PlainRow>
            </Group>
          ) : (
            <>
              <SegmentedControl
                size="full"
                accessibilityLabel="What to request"
                value={state.material}
                onChange={setMaterial}
                options={[
                  { value: 'all', label: 'All pending', detail: q(lines.reduce((n, l) => n + l.pendingKg, 0)) },
                  { value: 'company', label: 'One company', detail: orList(openSubs.map((s) => s.companyCode)) },
                  { value: 'lines', label: 'Pick lines', detail: q(state.material === 'lines' ? total : lines.reduce((n, l) => n + l.pendingKg, 0)) },
                ]}
              />
              <Group>
                {state.material === 'all'
                  ? rows.map(({ s, l, name }) => <LineSummaryRow key={l.id} code={s.companyCode} slot={slot(s.companyCode)} name={name} qty={q(l.pendingKg)} />)
                  : state.material === 'company'
                    ? openSubs.map((s) => (
                        <SubOrderRow
                          key={s.id}
                          code={s.companyCode}
                          slot={slot(s.companyCode)}
                          name={`${s.companyName} · ${s.suffix}`}
                          pending={q(lines.filter((l) => l.subOrderId === s.id).reduce((n, l) => n + l.pendingKg, 0))}
                          checked={s.id === state.subOrderId}
                          onPress={() => dispatch({ type: 'subOrder', subOrderId: s.id })}
                        />
                      ))
                    : rows.map(({ s, l, name }) => {
                        const pick = state.picks[l.id] ?? { on: false, kg: 0 };
                        const part = pick.on && pick.kg < l.pendingKg;
                        return (
                          <PickLineRow
                            key={l.id}
                            code={s.companyCode}
                            slot={slot(s.companyCode)}
                            name={name}
                            caption={`${q(l.pendingKg)} pending${part ? ' · asking part' : ''}`}
                            unit={unit}
                            on={pick.on}
                            value={state.texts[l.id] ?? toDisplayQty(pick.kg, basis)}
                            decimal={basis === 'mt'}
                            onToggle={() => dispatch({ type: 'toggleLine', lineId: l.id })}
                            onChangeText={(text) => dispatch({ type: 'lineText', lineId: l.id, text, basis })}
                            onBlur={() => dispatch({ type: 'lineBlur', lineId: l.id })}
                          />
                        );
                      })}
                <TotalRow qty={q(total)} />
              </Group>
            </>
          )}
        </View>

        <View style={styles.section}>
          <View style={styles.msgHead}>
            <Text variant="overline" style={styles.fill}>
              Message · you can edit
            </Text>
            {state.messageStale ? <LinkButton label="Update message" onPress={() => dispatch({ type: 'refreshMessage' })} /> : null}
            <LinkButton label="Copy" accessibilityLabel="Copy message" onPress={() => void copy()} />
          </View>
          <TextInput
            {...inputTheme(t, scheme)}
            accessibilityLabel="Message"
            multiline
            value={state.message}
            onChangeText={(text) => dispatch({ type: 'editMessage', text })}
            textAlignVertical="top"
            style={[styles.msg, { backgroundColor: t.ctl, color: t.tx, fontFamily: fontFamily.regular, fontSize: 13 * scale, lineHeight: 19 * scale }]}
          />
        </View>
      </ScrollView>

      <View style={[styles.foot, { borderTopColor: t.bd }]}>
        <Button
          variant="secondary"
          icon="phone"
          disabled={!number || total <= 0 || busy === 'whatsapp'}
          loading={busy === 'call'}
          onPress={() => void once(() => record('call'))}
          accessibilityLabel={contact ? `Call ${contact.name}` : 'Call'}
        >
          Call
        </Button>
        <Button
          variant="whatsapp"
          icon="chat"
          disabled={!canWhatsApp || total <= 0 || busy === 'call'}
          loading={busy === 'whatsapp'}
          onPress={() => void once(() => record('whatsapp'))}
          style={styles.fill}
        >
          Send on WhatsApp
        </Button>
      </View>
    </Sheet>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, minWidth: 0 },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: 12 },
  sub: { fontSize: 13, marginTop: 2 },
  close: { width: 44, height: 44, borderRadius: 22, overflow: 'hidden' },
  body: { gap: 18, paddingBottom: 4 },
  section: { gap: 8 },
  msgHead: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  msg: { borderRadius: 14, paddingVertical: 12, paddingHorizontal: 14, minHeight: 150 },
  foot: { flexDirection: 'row', gap: 10, borderTopWidth: 1, marginHorizontal: -20, paddingHorizontal: 20, paddingTop: 12 },
});
