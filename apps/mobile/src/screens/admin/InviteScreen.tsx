import { zodResolver } from '@hookform/resolvers/zod';
import { formatMobile } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Controller, type Resolver, useForm } from 'react-hook-form';
import {
  fieldErrorsFrom,
  type InviteFormInput,
  type InviteFormValues,
  inviteFormSchema,
} from '../../admin/forms';
import { ApiError } from '../../api/client';
import { useCompanies } from '../../api/hooks/companies';
import { usePlants } from '../../api/hooks/plants';
import { useInviteUser, useUsers } from '../../api/hooks/users';
import { useSubmitKey } from '../../api/submitKey';
import { Button, Screen, showToast, TextField } from '../../ui';
import { MSG, messageFor } from '../messages';
import { AccessFields, BackHeader, FormMessage } from './parts';

const EMPTY: InviteFormInput = { name: '', mobile: '', role: undefined, plantIds: [] };

/** Canvas "Invite user": name, mobile, role, plant access, live permission preview. */
export function InviteScreen() {
  const router = useRouter();
  const { data: companies } = useCompanies();
  const { data: plants } = usePlants();
  const { data: users } = useUsers();
  const invite = useInviteUser();
  const submitKey = useSubmitKey();
  const [formError, setFormError] = useState<string | undefined>();

  const { control, handleSubmit, watch, setValue, setError, formState } = useForm<
    InviteFormInput,
    unknown,
    InviteFormValues
  >({
    defaultValues: EMPTY,
    mode: 'onTouched',
    resolver: zodResolver(inviteFormSchema) as unknown as Resolver<
      InviteFormInput,
      unknown,
      InviteFormValues
    >,
  });
  const [name, role, plantIds] = watch(['name', 'role', 'plantIds']);

  const submit = handleSubmit(async (v) => {
    setFormError(undefined);
    try {
      const u = await invite.mutateAsync({ body: v, key: submitKey.key() });
      submitKey.settle();
      showToast(`${u.name} can now sign in with ${formatMobile(u.mobile)}`);
      router.back();
    } catch (e) {
      submitKey.settle(e);
      if (e instanceof ApiError && e.code === 'MOBILE_EXISTS') {
        setError('mobile', { message: MSG.mobileExists }, { shouldFocus: true });
      } else if (e instanceof ApiError && e.code === 'PLANT_RULE') {
        setError('plantIds', { message: MSG.plantRule });
      } else {
        const fields = fieldErrorsFrom(e, ['name', 'mobile', 'role', 'plantIds'] as const);
        const entries = Object.entries(fields) as [keyof InviteFormInput, string][];
        if (entries.length > 0) entries.forEach(([f, m]) => setError(f, { message: m }));
        else setFormError(messageFor(e));
      }
    }
  });

  return (
    <Screen
      title="Invite user"
      keyboard
      header={<BackHeader />}
      footer={
        <>
          <FormMessage>{formError}</FormMessage>
          <Button
            onPress={() => void submit()}
            loading={formState.isSubmitting}
            disabled={!formState.isValid}
          >
            Send invite
          </Button>
        </>
      }
    >
      <Controller
        control={control}
        name="name"
        render={({ field, fieldState }) => (
          <TextField
            label="Full name"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            ref={field.ref}
            error={fieldState.error?.message}
            autoCapitalize="words"
            autoComplete="name"
            textContentType="name"
            returnKeyType="next"
            maxLength={120}
          />
        )}
      />
      <Controller
        control={control}
        name="mobile"
        render={({ field, fieldState }) => (
          <TextField
            label="Mobile number"
            prefix="+91"
            value={field.value}
            onChangeText={field.onChange}
            onBlur={field.onBlur}
            ref={field.ref}
            error={fieldState.error?.message}
            hint="They sign in with a one-time code sent to this number."
            keyboardType="phone-pad"
            textContentType="telephoneNumber"
            autoComplete="tel"
            maxLength={16}
            placeholder="98260 12345"
          />
        )}
      />
      <AccessFields
        name={name}
        role={role}
        plantIds={plantIds}
        companies={companies}
        plants={plants}
        users={users}
        plantError={formState.errors.plantIds?.message}
        onChange={(next) => {
          setValue('role', next.role, { shouldValidate: true });
          // Plant errors appear once a plant was picked (or after a submit), not on the role tap.
          setValue('plantIds', next.plantIds, {
            shouldValidate: next.plantIds.length > 0 || formState.isSubmitted,
          });
        }}
      />
    </Screen>
  );
}
