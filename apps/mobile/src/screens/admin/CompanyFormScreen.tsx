import { zodResolver } from '@hookform/resolvers/zod';
import type { Company } from '@tonnage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { Controller, type Resolver, useForm } from 'react-hook-form';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import {
  type CompanyFormInput,
  type CompanyFormValues,
  companyFormDefaults,
  companyFormSchema,
  companyPatch,
  fieldErrorsFrom,
  suggestPrefix,
  toCompanyBody,
} from '../../admin/forms';
import { ApiError } from '../../api/client';
import {
  COMPANIES_KEY,
  useCompanies,
  useCreateCompany,
  useUpdateCompany,
} from '../../api/hooks/companies';
import { usePlants } from '../../api/hooks/plants';
import { currentIdentity } from '../../api/hooks/cache';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { useTheme } from '../../theme/ThemeProvider';
import {
  Badge,
  Button,
  EmptyState,
  Group,
  Icon,
  Row,
  Screen,
  SectionLabel,
  showToast,
  Switch,
  Text,
  TextField,
} from '../../ui';
import { MSG, messageFor } from '../messages';
import { BackHeader, firstTryNote, FormMessage } from './parts';

const FIELDS = ['code', 'name', 'gstin', 'orderPrefix'] as const;

/** Add (`id === 'new'`) or edit a company; editing also lists its plants. */
export function CompanyFormScreen({ id }: { id: string }) {
  const isNew = id === 'new';
  const { t } = useTheme();
  const companies = useCompanies();
  const company = isNew ? undefined : companies.data?.find((c) => c.id === id);

  if (!isNew && !company) {
    return (
      <Screen header={<BackHeader />}>
        {companies.isPending ? (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        ) : (
          <EmptyState
            icon="factory"
            title="Not found"
            body={companies.isError ? messageFor(companies.error) : MSG.notFound}
            actions={
              companies.isError
                ? [{ label: 'Try again', onPress: () => void companies.refetch() }]
                : []
            }
          />
        )}
      </Screen>
    );
  }
  // Remount when switching records so the form starts from that record.
  return <CompanyForm key={company?.id ?? 'new'} company={company} />;
}

function CompanyForm({ company }: { company: Company | undefined }) {
  const router = useRouter();
  const qc = useQueryClient();
  const create = useCreateCompany();
  const update = useUpdateCompany();
  const submitKey = useSubmitKey();
  const once = useSingleFlight();
  const [formError, setFormError] = useState<string | undefined>();
  /**
   * The record as it was when the owner started editing. Edits are diffed against it and sent with
   * its version, so a change saved meanwhile on another phone comes back as STALE instead of being
   * overwritten — even after a background refetch has moved the cached copy ahead.
   */
  const [base, setBase] = useState(company);
  // A new company's prefix follows its code ("SO-BSP") until the owner types their own.
  const prefixEdited = useRef(Boolean(company));

  const { control, handleSubmit, reset, setValue, setError, formState } = useForm<
    CompanyFormInput,
    unknown,
    CompanyFormValues
  >({
    defaultValues: companyFormDefaults(company),
    mode: 'onTouched',
    resolver: zodResolver(companyFormSchema) as unknown as Resolver<
      CompanyFormInput,
      unknown,
      CompanyFormValues
    >,
  });

  // Read during render so react-hook-form tracks it.
  const { isDirty } = formState;
  // Someone else's change arrived while the form is untouched: follow it.
  const version = company?.version;
  useEffect(() => {
    if (company && !isDirty && company.version !== base?.version) {
      setBase(company);
      reset(companyFormDefaults(company));
    }
  }, [version, isDirty]);

  const onError = (e: unknown) => {
    const fields = fieldErrorsFrom(e, FIELDS);
    const entries = Object.entries(fields) as [(typeof FIELDS)[number], string][];
    if (entries.length > 0) entries.forEach(([f, m]) => setError(f, { message: m }));
    else setFormError(messageFor(e));
  };

  const submit = handleSubmit(async (v) => {
    setFormError(undefined);
    const identity = currentIdentity();
    const stillHere = () => currentIdentity() === identity;
    if (!base) {
      const body = toCompanyBody(v);
      try {
        const c = await create.mutateAsync({ body, key: submitKey.key() });
        submitKey.settle();
        if (!stillHere()) return;
        if (companyPatch(c, v)) {
          // A lost earlier try with other details was replayed by the key: show what exists.
          showToast(firstTryNote(`${c.code} · ${c.name}`));
          router.replace(`/companies/${c.id}`);
          return;
        }
        showToast(`${c.code} added. Add its plants next.`);
        router.back();
      } catch (e) {
        submitKey.settle(e);
        if (stillHere()) onError(e);
      }
      return;
    }
    const patch = companyPatch(base, v);
    if (!patch) return router.back();
    try {
      const c = await update.mutateAsync({ id: base.id, patch });
      if (!stillHere()) return;
      setBase(c);
      reset(companyFormDefaults(c));
      showToast('Saved');
    } catch (e) {
      if (!stillHere()) return;
      if (e instanceof ApiError && e.code === 'STALE') {
        showToast(MSG.stale);
        await qc.refetchQueries({ queryKey: COMPANIES_KEY });
        const fresh = qc.getQueryData<Company[]>(COMPANIES_KEY)?.find((x) => x.id === base.id);
        if (fresh) {
          setBase(fresh);
          reset(companyFormDefaults(fresh));
        }
      } else onError(e);
    }
  });

  async function setActive(active: boolean) {
    if (!company) return;
    setFormError(undefined);
    const sentVersion = company.version;
    try {
      const c = await update.mutateAsync({
        id: company.id,
        patch: { active, version: sentVersion },
      });
      // Our own switch moved the version on: keep the form's base in step so Save still works.
      setBase((b) =>
        b && b.version === sentVersion ? { ...b, active: c.active, version: c.version } : b,
      );
      showToast(active ? `${company.code} is active again` : `${company.code} is inactive`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE') {
        showToast(MSG.stale);
        await qc.refetchQueries({ queryKey: COMPANIES_KEY });
      } else setFormError(messageFor(e));
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <Screen
      title={company ? company.name : 'Add company'}
      keyboard
      header={<BackHeader />}
      footer={
        <>
          <FormMessage>{formError}</FormMessage>
          <Button
            onPress={() => void once(submit)}
            loading={formState.isSubmitting}
            disabled={busy}
          >
            {company ? 'Save changes' : 'Add company'}
          </Button>
        </>
      }
    >
      <Controller
        control={control}
        name="code"
        render={({ field, fieldState }) => (
          <TextField
            label="Code"
            value={field.value}
            onChangeText={(v) => {
              const code = v.toUpperCase();
              field.onChange(code);
              if (!prefixEdited.current) setValue('orderPrefix', suggestPrefix(code));
            }}
            onBlur={field.onBlur}
            ref={field.ref}
            error={fieldState.error?.message}
            hint="2 to 5 letters. Shown on unit tags, e.g. AIP."
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={5}
          />
        )}
      />
      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <TextField
            label="Company name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            ref={field.ref}
            error={fieldState.error?.message}
            autoCapitalize="words"
            maxLength={120}
          />
        )}
      />
      <Controller
        control={control}
        name="gstin"
        render={({ field, fieldState }) => (
          <TextField
            label="GSTIN"
            value={field.value}
            onChangeText={(v) => field.onChange(v.toUpperCase())}
            onBlur={field.onBlur}
            ref={field.ref}
            error={fieldState.error?.message}
            hint="15 characters, e.g. 22AAJCA4410K1ZQ. Leave empty if not registered yet."
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={20}
          />
        )}
      />
      <Controller
        control={control}
        name="orderPrefix"
        render={({ field, fieldState }) => (
          <TextField
            label="Order number prefix"
            value={field.value}
            onChangeText={(v) => {
              prefixEdited.current = true;
              field.onChange(v);
            }}
            onBlur={field.onBlur}
            ref={field.ref}
            error={fieldState.error?.message}
            hint="Starts each sub-order number for this company."
            autoCapitalize="characters"
            autoCorrect={false}
            maxLength={20}
          />
        )}
      />

      {company ? <PlantsSection company={company} /> : null}

      {company ? (
        <Group>
          <Row>
            <View style={styles.fill}>
              <Text weight="medium">Active</Text>
              <Text variant="caption">
                Inactive companies can&apos;t take new orders. Their history stays.
              </Text>
            </View>
            <Switch
              label="Active"
              value={company.active}
              onChange={(v) => void setActive(v)}
              disabled={busy}
            />
          </Row>
        </Group>
      ) : null}
    </Screen>
  );
}

function PlantsSection({ company }: { company: Company }) {
  const router = useRouter();
  const { t } = useTheme();
  const { data: plants } = usePlants();
  const own = (plants ?? [])
    .filter((p) => p.companyId === company.id)
    .sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <SectionLabel>Plants</SectionLabel>
      <Group>
        {own.map((p) => (
          <Row
            key={p.id}
            accessibilityLabel={`${p.name}, ${p.location}${p.active ? '' : ', inactive'}`}
            onPress={() =>
              router.push({
                pathname: '/companies/plant',
                params: { companyId: company.id, id: p.id },
              })
            }
          >
            <View style={styles.fill}>
              <Text weight="medium">{p.name}</Text>
              <Text variant="caption">{p.location}</Text>
            </View>
            {p.active ? null : <Badge kind="nu">Inactive</Badge>}
            <Icon name="chevronRight" size={18} color={t.tx3} />
          </Row>
        ))}
        <Row
          accessibilityLabel="Add plant"
          onPress={() =>
            router.push({ pathname: '/companies/plant', params: { companyId: company.id } })
          }
        >
          <Icon name="plus" size={20} color={t.brt} />
          <Text weight="medium" color="brt" style={styles.fill}>
            Add plant
          </Text>
        </Row>
      </Group>
    </>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
