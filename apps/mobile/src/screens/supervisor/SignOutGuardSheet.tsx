import { useEffect, useState } from 'react';
import { notSent, syncNow, useSyncStatus } from '../../offline/useSync';
import { Button, Text, TextField } from '../../ui';
import { Sheet } from '../../ui/Sheet';
import { weights } from './usePlantTitle';

/** What has to be typed before signing out with weights still on this phone. */
export const SIGN_OUT_WORD = 'SIGN OUT';

/**
 * Ruling 11: signing out (or switching person) with weights not sent yet. "Send now" syncs;
 * "Sign out anyway" needs `SIGN OUT` typed. Either way the weights stay in this person's
 * device store on this phone and go out when they sign in again.
 */
export function SignOutGuardSheet({
  visible,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  onClose(): void;
  /** Sign out (or switch): all sent, or confirmed anyway. */
  onConfirm(): void;
}) {
  const { online, rejected } = useSyncStatus();
  const pending = useSyncStatus(notSent);
  const [sending, setSending] = useState(false);
  const [typing, setTyping] = useState(false);
  const [typed, setTyped] = useState('');
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (visible) return;
    setTyping(false);
    setTyped('');
    setTried(false);
  }, [visible]);

  const allSent = pending === 0;
  const title = allSent ? 'All weights sent' : `${weights(pending)} not sent yet`;

  return (
    <Sheet visible={visible} title={title} onClose={onClose} busy={sending}>
      {allSent ? (
        <>
          <Text color="tx2">Everything on this phone has reached the server.</Text>
          <Button onPress={onConfirm}>Sign out</Button>
        </>
      ) : typing ? (
        <>
          <Text color="tx2">
            {`The ${pending === 1 ? 'weight stays' : 'weights stay'} on this phone and ${pending === 1 ? 'is' : 'are'} sent the next time you sign in here.`}
          </Text>
          <TextField
            label={`Type ${SIGN_OUT_WORD} to confirm`}
            value={typed}
            onChangeText={setTyped}
            autoCapitalize="characters"
            autoCorrect={false}
            autoFocus
          />
          <Button
            variant="danger"
            disabled={typed.trim() !== SIGN_OUT_WORD}
            onPress={onConfirm}
          >
            Sign out anyway
          </Button>
          <Button variant="secondary" onPress={onClose}>
            Cancel
          </Button>
        </>
      ) : (
        <>
          <Text color="tx2">
            {pending === 1
              ? 'It is saved on this phone. Send it before you sign out.'
              : 'They are saved on this phone. Send them before you sign out.'}
          </Text>
          {rejected > 0 ? (
            <Text color="tx2">{`${weights(rejected)} wait for the owner to check.`}</Text>
          ) : null}
          {tried && online === false ? (
            <Text color="wnt" accessibilityLiveRegion="polite">
              No network. Try again when the phone is online.
            </Text>
          ) : null}
          <Button
            loading={sending}
            onPress={() => {
              setSending(true);
              void syncNow().finally(() => {
                setSending(false);
                setTried(true);
              });
            }}
          >
            Send now
          </Button>
          <Button variant="secondary" disabled={sending} onPress={() => setTyping(true)}>
            Sign out anyway
          </Button>
        </>
      )}
    </Sheet>
  );
}
