import * as LocalAuthentication from 'expo-local-authentication';
import { useLocalSearchParams, useRouter } from 'expo-router';
import {
  type TenantChoiceDetails,
  requestCodeResponseSchema,
  tenantChoiceDetailsSchema,
  tokenPairSchema,
} from '@tonnage/shared';
import { useEffect, useRef, useState } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import { ApiError, api } from '../api/client';
import { useSession } from '../auth/session';
import { useTheme } from '../theme/ThemeProvider';
import { Button, Group, OtpInput, Row, Screen, Switch, Text } from '../ui';
import { Brand } from './Brand';
import { messageFor } from './messages';
import { maskMobile } from './SignInScreen';

const RESEND_AFTER_S = 30;
const CODE_LENGTH = 6;

export function VerifyScreen() {
  const router = useRouter();
  const { mobile = '' } = useLocalSearchParams<{ mobile?: string }>();
  const { t, setPrefs } = useTheme();
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const [tenants, setTenants] = useState<TenantChoiceDetails | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(RESEND_AFTER_S);
  const [canUseBiometrics, setCanUseBiometrics] = useState(false);
  const [useFingerprint, setUseFingerprint] = useState(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    void (async () => {
      const ok =
        (await LocalAuthentication.hasHardwareAsync()) &&
        (await LocalAuthentication.isEnrolledAsync());
      if (!alive.current) return;
      setCanUseBiometrics(ok);
      setUseFingerprint(ok); // on by default when the phone has a fingerprint or face enrolled
    })();
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setTimeout(() => setSecondsLeft((s) => s - 1), 1000);
    return () => clearTimeout(id);
  }, [secondsLeft]);

  async function verify(value: string, tenantId?: string) {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      const deviceId = await useSession.getState().ensureDeviceId();
      const pair = await api('/v1/auth/verify', {
        method: 'POST',
        auth: false,
        body: { mobile, code: value, deviceId, ...(tenantId ? { tenantId } : {}) },
        schema: tokenPairSchema,
      });
      await setPrefs({ fingerprint: canUseBiometrics && useFingerprint });
      await useSession.getState().signIn(pair);
      router.replace('/');
    } catch (e) {
      if (e instanceof ApiError && e.code === 'TENANT_CHOICE_REQUIRED') {
        const parsed = tenantChoiceDetailsSchema.safeParse(e.details);
        if (parsed.success) {
          setTenants(parsed.data); // keep the code: the 409 does not use it up
          return;
        }
      }
      setError(messageFor(e));
      setCode('');
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function resend() {
    setError(undefined);
    setCode('');
    setTenants(null);
    try {
      await api('/v1/auth/request-code', {
        method: 'POST',
        auth: false,
        body: { mobile },
        schema: requestCodeResponseSchema,
      });
      setSecondsLeft(RESEND_AFTER_S);
    } catch (e) {
      setError(messageFor(e));
    }
  }

  if (tenants) {
    return (
      <Screen>
        <Brand />
        <View style={styles.intro}>
          <Text variant="title" accessibilityRole="header">
            Which company group?
          </Text>
          <Text color="tx2" style={styles.lead}>
            {maskMobile(mobile)} is set up in more than one group. Choose where to sign in.
          </Text>
        </View>
        <Group>
          {tenants.map((x) => (
            <Row
              key={x.tenantId}
              accessibilityLabel={x.tenantName}
              onPress={() => void verify(code, x.tenantId)}
              disabled={busy}
            >
              <Text weight="medium" style={styles.fill}>
                {x.tenantName}
              </Text>
            </Row>
          ))}
        </Group>
        {error ? (
          <Text color="dgt" accessibilityLiveRegion="assertive" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
      </Screen>
    );
  }

  const mm = Math.floor(secondsLeft / 60);
  const ss = String(secondsLeft % 60).padStart(2, '0');

  return (
    <Screen keyboard contentStyle={styles.content}>
      <Brand />
      <View style={styles.intro}>
        <Text variant="title" accessibilityRole="header">
          Enter the code
        </Text>
        <Text color="tx2" style={styles.lead}>
          We sent a 6-digit code to{' '}
          <Text weight="medium" style={styles.lead}>
            {maskMobile(mobile)}
          </Text>
          .{' '}
          <Text
            weight="medium"
            color="brt"
            style={styles.lead}
            accessibilityRole="link"
            onPress={() => router.back()}
          >
            Change
          </Text>
        </Text>
      </View>

      <View style={styles.codeBlock}>
        <OtpInput
          length={CODE_LENGTH}
          value={code}
          autoFocus
          invalid={Boolean(error)}
          editable={!busy}
          onChange={(v) => {
            setCode(v);
            if (error) setError(undefined);
            if (v.length === CODE_LENGTH) void verify(v);
          }}
        />
        {error ? (
          <Text color="dgt" accessibilityLiveRegion="assertive" accessibilityRole="alert">
            {error}
          </Text>
        ) : null}
        {secondsLeft > 0 ? (
          <Text variant="caption" style={styles.resend}>
            {`Resend code in ${mm}:${ss}`}
          </Text>
        ) : (
          <Pressable
            accessibilityRole="button"
            onPress={() => void resend()}
            hitSlop={12}
            style={styles.resendBtn}
          >
            <Text weight="medium" color="brt" style={styles.resend}>
              Resend code
            </Text>
          </Pressable>
        )}
      </View>

      <View style={styles.spacer} />

      {canUseBiometrics ? (
        <View style={[styles.card, { backgroundColor: t.card, borderColor: t.bd }]}>
          <View style={styles.fill}>
            <Text weight="medium">Unlock with fingerprint</Text>
            <Text variant="caption">Skip the code on this phone next time</Text>
          </View>
          <Switch
            label="Unlock with fingerprint"
            value={useFingerprint}
            onChange={setUseFingerprint}
          />
        </View>
      ) : null}
      <Button
        onPress={() => void verify(code)}
        disabled={code.length !== CODE_LENGTH}
        loading={busy}
      >
        Verify and continue
      </Button>
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { paddingHorizontal: 24, paddingTop: 56, gap: 16 },
  intro: { marginTop: 64, gap: 8 },
  lead: { fontSize: 15, lineHeight: 22 },
  codeBlock: { marginTop: 16, gap: 16 },
  resend: { fontSize: 13 },
  resendBtn: { alignSelf: 'flex-start', minHeight: 24, justifyContent: 'center' },
  spacer: { flex: 1, minHeight: 24 },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 12,
    paddingVertical: 14,
    paddingHorizontal: 16,
    borderRadius: 14,
    borderWidth: 1,
  },
});
