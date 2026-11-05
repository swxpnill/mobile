import { normalizeIndianMobile, requestCodeResponseSchema } from '@tonnage/shared';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { ApiError, api } from '../api/client';
import { Button, Screen, Text, TextField } from '../ui';
import { Brand } from './Brand';
import { MSG, messageFor } from './messages';

/** "+919826012345" → "+91 98260 ••345" (the canvas verify subtitle). */
export function maskMobile(normalized: string): string {
  const d = normalized.replace(/^\+91/, '');
  return `+91 ${d.slice(0, 5)} ••${d.slice(7)}`;
}

export function SignInScreen() {
  const router = useRouter();
  const [raw, setRaw] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const mobile = normalizeIndianMobile(raw);
  const fieldError = touched && raw.trim() !== '' && !mobile ? MSG.invalidMobile : undefined;

  async function send() {
    if (!mobile || busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await api('/v1/auth/request-code', {
        method: 'POST',
        auth: false,
        body: { mobile },
        schema: requestCodeResponseSchema,
      });
      router.push({ pathname: '/verify', params: { mobile } });
    } catch (e) {
      // A code was sent under 30 s ago: it is still valid, so go and enter it.
      if (e instanceof ApiError && e.code === 'OTP_RESEND_TOO_SOON') {
        router.push({ pathname: '/verify', params: { mobile } });
      } else {
        setError(messageFor(e));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Screen keyboard contentStyle={styles.content}>
      <Brand />
      <View style={styles.intro}>
        <Text variant="title" accessibilityRole="header">
          Sign in
        </Text>
        <Text color="tx2" style={styles.lead}>
          Enter your mobile number. We&apos;ll send a 6-digit code to it.
        </Text>
      </View>
      <TextField
        label="Mobile number"
        prefix="+91"
        value={raw}
        onChangeText={(v) => {
          setRaw(v);
          setError(undefined);
        }}
        onBlur={() => setTouched(true)}
        keyboardType="phone-pad"
        textContentType="telephoneNumber"
        autoComplete="tel"
        autoFocus
        maxLength={16}
        placeholder="98260 12345"
        returnKeyType="go"
        onSubmitEditing={() => void send()}
        hint={mobile ? "We'll send a 6-digit code to this number." : MSG.invalidMobile}
        error={fieldError}
      />
      {error ? (
        <Text color="dgt" accessibilityLiveRegion="assertive" accessibilityRole="alert">
          {error}
        </Text>
      ) : null}
      <View style={styles.spacer} />
      <Button onPress={() => void send()} disabled={!mobile} loading={busy}>
        Send code
      </Button>
    </Screen>
  );
}

const styles = StyleSheet.create({
  content: { paddingHorizontal: 24, paddingTop: 56, gap: 24 },
  intro: { marginTop: 64, gap: 8 },
  lead: { fontSize: 15, lineHeight: 22 },
  spacer: { flex: 1, minHeight: 24 },
});
