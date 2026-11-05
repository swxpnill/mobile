import { zodResolver } from '@hookform/resolvers/zod';
import type { Plant } from '@tonnage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { fieldErrorsFrom, type PlantFormValues, plantFormSchema } from '../../admin/forms';
import { ApiError } from '../../api/client';
import { useCompanies } from '../../api/hooks/companies';
import { PLANTS_KEY, useCreatePlant, usePlants, useUpdatePlant } from '../../api/hooks/plants';
import { currentIdentity } from '../../api/hooks/cache';
import { useSingleFlight, useSubmitKey } from '../../api/submitKey';
import { useTheme } from '../../theme/ThemeProvider';
import {
  Button,
  EmptyState,
  Group,
  Row,
  Screen,
  showToast,
  Switch,
  Text,
  TextField,
} from '../../ui';
import { MSG, messageFor } from '../messages';
import { BackHeader, firstTryNote, FormMessage } from './parts';

/** Add a plant to a company (`id` absent) or edit one. */
export function PlantFormScreen({ companyId, id }: { companyId: string; id?: string }) {
  const { t } = useTheme();
  const companies = useCompanies();
  const plants = usePlants();
  const company = companies.data?.find((c) => c.id === companyId);
  const plant = id ? plants.data?.find((p) => p.id === id) : undefined;

  if (!company || (id && !plant)) {
    const loading = companies.isPending || plants.isPending;
    return (
      <Screen header={<BackHeader />}>
        {loading ? (
          <ActivityIndicator color={t.br} accessibilityLabel="Loading" />
        ) : (
          <EmptyState icon="factory" title="Not found" body={MSG.notFound} />
        )}
      </Screen>
    );
  }
  return (
    <PlantForm
      key={plant?.id ?? 'new'}
      companyId={company.id}
      companyCode={company.code}
      plant={plant}
    />
  );
}

function PlantForm({
  companyId,
  companyCode,
  plant,
}: {
  companyId: string;
  companyCode: string;
  plant: Plant | undefined;
}) {
  const router = useRouter();
  const qc = useQueryClient();
  const create = useCreatePlant();
  const update = useUpdatePlant();
  const submitKey = useSubmitKey();
  const once = useSingleFlight();
  const [formError, setFormError] = useState<string | undefined>();
  /** The plant as it was when editing started; diffed against and versioned from (see company form). */
  const [base, setBase] = useState(plant);
  const { control, handleSubmit, reset, setError, formState } = useForm<PlantFormValues>({
    defaultValues: { name: plant?.name ?? '', location: plant?.location ?? '' },
    mode: 'onTouched',
    resolver: zodResolver(plantFormSchema),
  });
  const { isDirty } = formState;
  const version = plant?.version;
  useEffect(() => {
    if (plant && !isDirty && plant.version !== base?.version) {
      setBase(plant);
      reset({ name: plant.name, location: plant.location });
    }
  }, [version, isDirty]);

  const onError = (e: unknown) => {
    const fields = fieldErrorsFrom(e, ['name', 'location'] as const);
    const entries = Object.entries(fields) as ['name' | 'location', string][];
    if (entries.length > 0) entries.forEach(([f, m]) => setError(f, { message: m }));
    else setFormError(messageFor(e));
  };

  const reloadAfterStale = async () => {
    showToast(MSG.stale);
    await qc.refetchQueries({ queryKey: PLANTS_KEY });
    const fresh = qc.getQueryData<Plant[]>(PLANTS_KEY)?.find((p) => p.id === plant?.id);
    if (fresh) {
      setBase(fresh);
      reset({ name: fresh.name, location: fresh.location });
    }
  };

  const submit = handleSubmit(async (v) => {
    setFormError(undefined);
    const identity = currentIdentity();
    const stillHere = () => currentIdentity() === identity;
    try {
      if (!base) {
        const p = await create.mutateAsync({ body: { companyId, ...v }, key: submitKey.key() });
        submitKey.settle();
        if (!stillHere()) return;
        if (p.name !== v.name || p.location !== v.location) {
          showToast(firstTryNote(`${p.name}, ${p.location}`));
          router.replace({ pathname: '/companies/plant', params: { companyId, id: p.id } });
          return;
        }
        showToast(`${p.name} added to ${companyCode}`);
        router.back();
        return;
      }
      if (v.name === base.name && v.location === base.location) return router.back();
      await update.mutateAsync({
        id: base.id,
        patch: {
          ...(v.name !== base.name ? { name: v.name } : {}),
          ...(v.location !== base.location ? { location: v.location } : {}),
          version: base.version,
        },
      });
      if (!stillHere()) return;
      showToast('Saved');
      router.back();
    } catch (e) {
      if (!base) submitKey.settle(e);
      if (!stillHere()) return;
      if (e instanceof ApiError && e.code === 'STALE') await reloadAfterStale();
      else onError(e);
    }
  });

  async function setActive(active: boolean) {
    if (!plant) return;
    setFormError(undefined);
    const sentVersion = plant.version;
    try {
      const p = await update.mutateAsync({ id: plant.id, patch: { active, version: sentVersion } });
      setBase((b) =>
        b && b.version === sentVersion ? { ...b, active: p.active, version: p.version } : b,
      );
      showToast(active ? `${plant.name} is active again` : `${plant.name} is inactive`);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'STALE') await reloadAfterStale();
      else setFormError(messageFor(e));
    }
  }

  const busy = create.isPending || update.isPending;

  return (
    <Screen
      title={plant ? plant.name : `Add plant to ${companyCode}`}
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
            {plant ? 'Save changes' : 'Add plant'}
          </Button>
        </>
      }
    >
      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <TextField
            label="Plant name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            ref={field.ref}
            error={fieldState.error?.message}
            hint="Usually the industrial area, e.g. Siltara."
            autoCapitalize="words"
            maxLength={120}
          />
        )}
      />
      <Controller
        control={control}
        name="location"
        render={({ field, fieldState }) => (
          <TextField
            label="Town or city"
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
      {plant ? (
        <Group>
          <Row>
            <View style={styles.fill}>
              <Text weight="medium">Active</Text>
              <Text variant="caption">
                Inactive plants get no new trucks and can&apos;t be given to new staff.
              </Text>
            </View>
            <Switch
              label="Active"
              value={plant.active}
              onChange={(v) => void setActive(v)}
              disabled={busy}
            />
          </Row>
        </Group>
      ) : null}
    </Screen>
  );
}

const styles = StyleSheet.create({ fill: { flex: 1 } });
