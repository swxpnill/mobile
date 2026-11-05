import { zodResolver } from '@hookform/resolvers/zod';
import type { Plant } from '@tonnage/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, useForm } from 'react-hook-form';
import { ActivityIndicator, StyleSheet, View } from 'react-native';
import { fieldErrorsFrom, type PlantFormValues, plantFormSchema } from '../../admin/forms';
import { ApiError } from '../../api/client';
import { useCompanies } from '../../api/hooks/companies';
import { PLANTS_KEY, useCreatePlant, usePlants, useUpdatePlant } from '../../api/hooks/plants';
import { useSubmitKey } from '../../api/submitKey';
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
import { BackHeader, FormMessage } from './parts';

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
  const [formError, setFormError] = useState<string | undefined>();
  const { control, handleSubmit, reset, setError, formState } = useForm<PlantFormValues>({
    defaultValues: { name: plant?.name ?? '', location: plant?.location ?? '' },
    mode: 'onTouched',
    resolver: zodResolver(plantFormSchema),
  });

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
    if (fresh) reset({ name: fresh.name, location: fresh.location });
  };

  const submit = handleSubmit(async (v) => {
    setFormError(undefined);
    try {
      if (!plant) {
        const p = await create.mutateAsync({ body: { companyId, ...v }, key: submitKey.key() });
        submitKey.settle();
        showToast(`${p.name} added to ${companyCode}`);
        router.back();
        return;
      }
      if (v.name === plant.name && v.location === plant.location) return router.back();
      await update.mutateAsync({
        id: plant.id,
        patch: {
          ...(v.name !== plant.name ? { name: v.name } : {}),
          ...(v.location !== plant.location ? { location: v.location } : {}),
          version: plant.version,
        },
      });
      showToast('Saved');
      router.back();
    } catch (e) {
      if (!plant) submitKey.settle(e);
      if (e instanceof ApiError && e.code === 'STALE') await reloadAfterStale();
      else onError(e);
    }
  });

  async function setActive(active: boolean) {
    if (!plant) return;
    setFormError(undefined);
    try {
      await update.mutateAsync({ id: plant.id, patch: { active, version: plant.version } });
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
          <Button onPress={() => void submit()} loading={formState.isSubmitting} disabled={busy}>
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
