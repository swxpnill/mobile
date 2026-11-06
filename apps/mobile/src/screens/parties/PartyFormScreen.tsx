import { type Party, type PartyType, checkGstin, normalizeGstin, unitLabel } from '@tonnage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { z } from 'zod';
import { ApiError } from '../../api/client';
import { currentIdentity } from '../../api/hooks/cache';
import { useDisplayBasis } from '../../api/hooks/me';
import { partyKey, useCreateParty, useParty, useUpdateParty } from '../../api/hooks/masters';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import {
  type ContactDraft,
  type FormErrors,
  type PartyDraft,
  MAX_CONTACTS,
  MAX_NUMBERS,
  ROLE_CHOICES,
  draftFromParty,
  emptyDraft,
  newContact,
  newNumber,
  newShipTo,
  partyBodyFrom,
} from '../../masters/partyForm';
import { useDiscardGuard } from '../../nav/discardGuard';
import { useTheme } from '../../theme/ThemeProvider';
import {
  Button,
  Chip,
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
} from '../../ui';
import { MSG, messageFor } from '../messages';
import { BackHeader, FormMessage, firstTryNote } from '../admin/parts';
import { PARTY_TYPE_LABEL, typesFor } from './PartiesScreen';


/** Add (`type`) or edit (`id`) a customer, broker or transporter — canvas board 19. */
export function PartyFormScreen({ id, type = 'customer' }: { id?: string; type?: PartyType }) {
  const { t } = useTheme();
  const party = useParty(id);
  if (id !== undefined && !party.data) {
    return (
      <Screen header={<BackHeader />}>
        {party.isPending ? (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        ) : (
          <EmptyState
            icon="users"
            title="Not found"
            body={party.isError ? messageFor(party.error) : MSG.notFound}
            actions={party.isError ? [{ label: 'Try again', onPress: () => void party.refetch() }] : []}
          />
        )}
      </Screen>
    );
  }
  return <PartyForm key={party.data?.id ?? 'new'} party={party.data} type={party.data?.type ?? type} />;
}

const gstinDetailsSchema = z.object({ partyId: z.string(), name: z.string() });

function PartyForm({ party, type: initialType }: { party: Party | undefined; type: PartyType }) {
  const router = useRouter();
  const qc = useQueryClient();
  const { t } = useTheme();
  const basis = useDisplayBasis();
  const create = useCreateParty();
  const update = useUpdateParty();
  const submitKey = useSubmitKey();
  const once = useSingleFlight();
  /** The record as it was when editing started: saved with its version so others' edits are not overwritten. */
  const [base, setBase] = useState(party);
  const initial = useMemo(() => (party ? draftFromParty(party, basis) : emptyDraft(initialType)), [party, basis, initialType]);
  const [d, setD] = useState<PartyDraft>(initial);
  const [errors, setErrors] = useState<FormErrors>({});
  const [formError, setFormError] = useState<string>();
  const [gstinOwner, setGstinOwner] = useState<{ partyId: string; name: string }>();
  const dirty = JSON.stringify(stripKeys(d)) !== JSON.stringify(stripKeys(initial));
  const guard = useDiscardGuard(dirty);

  // Someone else's save arrived while this form is untouched: follow it.
  useEffect(() => {
    if (party && !dirty && party.version !== base?.version) {
      setBase(party);
      setD(draftFromParty(party, basis));
    }
  }, [party?.version]);

  const patch = (change: Partial<PartyDraft>) => setD((x) => ({ ...x, ...change }));
  const setContact = (i: number, change: Partial<ContactDraft>) =>
    setD((x) => ({ ...x, contacts: x.contacts.map((c, ci) => (ci === i ? { ...c, ...change } : c)) }));

  const err = (key: string) => errors[key];
  const gstinCheck = d.gstin.replace(/\s/g, '').length === 15 ? checkGstin(d.gstin) : null;

  const submit = async () => {
    setFormError(undefined);
    setGstinOwner(undefined);
    const built = partyBodyFrom(d, basis);
    if (!built.ok) {
      setErrors(built.errors);
      if (built.errors.addresses) setFormError(built.errors.addresses);
      return;
    }
    setErrors({});
    const identity = currentIdentity();
    const stillHere = () => currentIdentity() === identity;
    try {
      if (!base) {
        const created = await create.mutateAsync({ body: built.body, key: submitKey.key() });
        submitKey.settle();
        if (!stillHere()) return;
        if (created.name !== built.body.name) showToast(firstTryNote(created.name));
        else showToast(`${created.name} added`);
        guard.allow();
        router.back();
        return;
      }
      const saved = await update.mutateAsync({ id: base.id, body: { ...built.body, version: base.version, active: d.active } });
      if (!stillHere()) return;
      setBase(saved);
      setD(draftFromParty(saved, basis));
      showToast('Saved');
      guard.allow();
      router.back();
    } catch (e) {
      if (!base) submitKey.settle(e);
      if (!stillHere()) return;
      if (e instanceof ApiError && e.code === 'GSTIN_EXISTS') {
        const owner = gstinDetailsSchema.safeParse(e.details);
        if (owner.success) setGstinOwner(owner.data);
        setErrors({ gstin: owner.success ? `Already used by ${owner.data.name}` : MSG.generic });
      } else if (e instanceof ApiError && e.code === 'STALE' && base) {
        showToast(MSG.stale);
        await qc.refetchQueries({ queryKey: partyKey(base.id) });
        const latest = qc.getQueryData<Party>(partyKey(base.id));
        if (latest) {
          setBase(latest);
          setD(draftFromParty(latest, basis));
        }
      } else if (e instanceof ApiError && e.code === 'PARTY_IN_USE') {
        setFormError('This ship-to site is used on orders, so it can’t be removed.');
      } else if (e instanceof ApiError && e.code === 'VALIDATION') {
        setFormError(messageFor(e));
      } else setFormError(messageFor(e));
    }
  };

  const busy = create.isPending || update.isPending;
  const typeLabel = PARTY_TYPE_LABEL[d.type];

  return (
    <Screen
      title={party ? 'Edit party' : `New ${typeLabel.one}`}
      keyboard
      header={<BackHeader />}
      footer={
        <>
          <FormMessage>{formError}</FormMessage>
          <Button onPress={() => void once(submit)} loading={busy} disabled={busy}>
            Save party
          </Button>
        </>
      }
    >
      {guard.sheet}
      <View style={styles.block}>
        <Text weight="medium" variant="caption">
          Party type
        </Text>
        {party ? (
          <Text variant="caption">{`${typeLabel.one.replace(/^./, (c) => c.toUpperCase())}. A party is one type only. Its type can’t change.`}</Text>
        ) : typesFor(initialType).length === 1 ? (
          <Text variant="caption">{`${typeLabel.one.replace(/^./, (c) => c.toUpperCase())}`}</Text>
        ) : (
          <>
            <SegmentedControl
              size="full"
              accessibilityLabel="Party type"
              value={d.type}
              onChange={(type) =>
                setD((x) => ({ ...x, type, shipTo: type === 'customer' && x.shipTo.length === 0 ? [newShipTo(true)] : x.shipTo }))
              }
              options={typesFor(initialType).map((x) => ({ value: x, label: PARTY_TYPE_LABEL[x].one.replace(/^./, (c) => c.toUpperCase()) }))}
            />
            <Text variant="caption">A party is one type only. Brokers also get a default commission.</Text>
          </>
        )}
      </View>

      <TextField label="Business name" value={d.name} onChangeText={(name) => patch({ name })} error={err('name')} autoCapitalize="words" maxLength={120} />
      <TextField
        label="GSTIN"
        value={d.gstin}
        onChangeText={(v) => patch({ gstin: normalizeGstin(v) })}
        error={err('gstin')}
        hint={gstinHint(gstinCheck, d.gstin)}
        autoCapitalize="characters"
        autoCorrect={false}
        maxLength={15}
      />
      {gstinOwner ? (
        <Button variant="secondary" onPress={() => router.push(`/parties/${gstinOwner.partyId}`)}>
          {`Open ${gstinOwner.name}`}
        </Button>
      ) : null}
      <TextField label="City" value={d.city} onChangeText={(city) => patch({ city })} error={err('city')} autoCapitalize="words" maxLength={60} />
      {d.type === 'broker' ? (
        <TextField
          label="Default commission"
          prefix="₹"
          value={d.commission}
          onChangeText={(commission) => patch({ commission })}
          error={err('defaultCommissionPerMt')}
          hint={`Per ${unitLabel(basis)}. Filled into new orders; each order can change it.`}
          keyboardType="decimal-pad"
          maxLength={12}
        />
      ) : null}
      {d.type !== 'transporter' ? (
        <TextField
          label="Payment terms"
          value={d.paymentTermsText}
          onChangeText={(paymentTermsText) => patch({ paymentTermsText })}
          hint="Optional, e.g. 15 days credit"
          maxLength={200}
        />
      ) : null}

      <SectionLabel>{`Contact people · ${d.contacts.length}`}</SectionLabel>
      {d.contacts.map((c, ci) => (
        <Group key={c.key}>
          <View style={styles.contact}>
            <View style={styles.inline}>
              <View style={styles.fill}>
                <TextField label="Contact name" value={c.name} onChangeText={(name) => setContact(ci, { name })} error={err(`contacts.${ci}.name`)} autoCapitalize="words" maxLength={80} />
              </View>
              {d.contacts.length > 1 ? (
                <IconButton icon="trash" label={`Remove ${c.name || 'person'}`} onPress={() => patch({ contacts: d.contacts.filter((_, i) => i !== ci) })} />
              ) : null}
            </View>
            <View style={styles.chips}>
              {[...ROLE_CHOICES, ...(c.roleLabel && !(ROLE_CHOICES as readonly string[]).includes(c.roleLabel) ? [c.roleLabel] : [])].map((r) => (
                <Chip key={r} label={r} selected={c.roleLabel === r} onPress={() => setContact(ci, { roleLabel: c.roleLabel === r ? '' : r })} />
              ))}
            </View>
            {c.numbers.map((n, ni) => (
              <View key={n.key} style={styles.number}>
                <View style={styles.inline}>
                  <View style={styles.fill}>
                    <TextField
                      label="Phone number"
                      prefix="+91"
                      value={n.number}
                      onChangeText={(number) =>
                        setContact(ci, { numbers: c.numbers.map((x, i) => (i === ni ? { ...x, number } : x)) })
                      }
                      error={err(`contacts.${ci}.numbers.${ni}.number`)}
                      keyboardType="phone-pad"
                      maxLength={16}
                    />
                  </View>
                  {c.numbers.length > 1 ? (
                    <IconButton icon="close" label={`Remove number ${ni + 1}`} onPress={() => setContact(ci, { numbers: c.numbers.filter((_, i) => i !== ni) })} />
                  ) : null}
                </View>
                <View style={styles.inline}>
                  <SegmentedControl
                    accessibilityLabel={`Number ${ni + 1} kind`}
                    value={n.label === 'Office' ? 'Office' : 'Mobile'}
                    onChange={(label) => setContact(ci, { numbers: c.numbers.map((x, i) => (i === ni ? { ...x, label } : x)) })}
                    options={[{ value: 'Mobile', label: 'Mobile' }, { value: 'Office', label: 'Office' }]}
                  />
                  <View style={styles.fill} />
                  <Text variant="caption">WhatsApp</Text>
                  <Switch
                    label={`WhatsApp on number ${ni + 1}`}
                    value={n.whatsapp}
                    onChange={(whatsapp) => setContact(ci, { numbers: c.numbers.map((x, i) => (i === ni ? { ...x, whatsapp } : x)) })}
                  />
                </View>
              </View>
            ))}
            {c.numbers.length < MAX_NUMBERS ? (
              <AddRow label="Add another number" onPress={() => setContact(ci, { numbers: [...c.numbers, newNumber('Office')] })} />
            ) : null}
          </View>
        </Group>
      ))}
      {d.contacts.length < MAX_CONTACTS ? (
        <Group>
          <AddRow label="Add contact person" onPress={() => patch({ contacts: [...d.contacts, newContact()] })} />
        </Group>
      ) : null}

      {d.type === 'customer' ? (
        <>
          <SectionLabel>Addresses</SectionLabel>
          <TextField
            label="Bill to address"
            value={d.billTo.address}
            onChangeText={(address) => patch({ billTo: { ...d.billTo, address } })}
            error={err('billTo')}
            multiline
            maxLength={200}
          />
          <SectionLabel>{`Ship to sites · ${d.shipTo.length}`}</SectionLabel>
          {d.shipTo.map((a, ai) => (
            <Group key={a.key}>
              <View style={styles.contact}>
                <View style={styles.inline}>
                  <View style={styles.fill}>
                    <TextField
                      label={`Site name ${ai + 1}`}
                      value={a.label}
                      onChangeText={(label) => patch({ shipTo: d.shipTo.map((x, i) => (i === ai ? { ...x, label } : x)) })}
                      hint="e.g. Hingna MIDC site"
                      maxLength={40}
                    />
                  </View>
                  <IconButton
                    icon="trash"
                    label={`Remove ship-to site ${ai + 1}`}
                    onPress={() => {
                      const rest = d.shipTo.filter((_, i) => i !== ai);
                      // The default moves to the first remaining site, so there is always exactly one.
                      if (a.isDefault && rest[0]) rest[0] = { ...rest[0], isDefault: true };
                      patch({ shipTo: rest });
                    }}
                  />
                </View>
                <TextField
                  label={`Site address ${ai + 1}`}
                  value={a.address}
                  onChangeText={(address) => patch({ shipTo: d.shipTo.map((x, i) => (i === ai ? { ...x, address } : x)) })}
                  error={err(`shipTo.${ai}.address`)}
                  multiline
                  maxLength={200}
                />
                <Row onPress={a.isDefault ? undefined : () => patch({ shipTo: d.shipTo.map((x, i) => ({ ...x, isDefault: i === ai })) })} accessibilityLabel={a.isDefault ? `Site ${ai + 1} is the default` : `Make site ${ai + 1} the default`}>
                  <Icon name={a.isDefault ? 'check' : 'mapPin'} size={18} color={a.isDefault ? t.okt : t.tx3} />
                  <Text color={a.isDefault ? 'okt' : 'tx2'} weight="medium">
                    {a.isDefault ? 'Default site' : 'Make default'}
                  </Text>
                </Row>
              </View>
            </Group>
          ))}
          <Group>
            <AddRow label="Add ship-to site" onPress={() => patch({ shipTo: [...d.shipTo, newShipTo(d.shipTo.length === 0)] })} />
          </Group>
        </>
      ) : null}

      {party ? (
        <Group>
          <Row>
            <View style={styles.fill}>
              <Text weight="medium">Active</Text>
              <Text variant="caption">Inactive parties are hidden from new orders. Their orders stay.</Text>
            </View>
            <Switch label="Active" value={d.active} onChange={(active) => patch({ active })} disabled={busy} />
          </Row>
        </Group>
      ) : null}
    </Screen>
  );
}

function AddRow({ label, onPress }: { label: string; onPress(): void }) {
  const { t } = useTheme();
  return (
    <Pressable accessibilityRole="button" accessibilityLabel={label} onPress={onPress} style={({ pressed }) => [styles.add, pressed ? { backgroundColor: t.act } : null]}>
      <Icon name="plus" size={20} color={t.brt} />
      <Text weight="medium" color="brt">
        {label}
      </Text>
    </Pressable>
  );
}

function gstinHint(check: ReturnType<typeof checkGstin> | null, typed: string): string {
  if (typed.trim() === '') return '15 characters, e.g. 27AAKFS1234L1Z5. Leave empty if not registered.';
  if (!check) return `${typed.replace(/\s/g, '').length} of 15 characters`;
  if (!check.ok) return check.reason === 'state' ? 'Unknown state code' : 'Not a GSTIN shape';
  return check.checksumOk ? `Valid · ${check.state}` : `${check.state} · check digit doesn’t match — double-check`;
}

/** Row keys are UI-only; dirty means the content changed. */
function stripKeys(d: PartyDraft): unknown {
  return JSON.parse(JSON.stringify(d, (k, v: unknown) => (k === 'key' ? undefined : v)));
}

const styles = StyleSheet.create({
  block: { gap: 8 },
  contact: { padding: 16, gap: 12 },
  number: { gap: 8 },
  inline: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  fill: { flex: 1, minWidth: 0 },
  add: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 16, minHeight: 52 },
});
