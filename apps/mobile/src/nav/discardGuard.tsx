import { useNavigation } from 'expo-router';
import { type ReactElement, useEffect, useRef, useState } from 'react';
import { ConfirmSheet } from '../ui/ConfirmSheet';

type BeforeRemove = { preventDefault(): void; data: { action: unknown } };
interface Nav {
  addListener(event: 'beforeRemove', cb: (e: BeforeRemove) => void): () => void;
  dispatch(action: unknown): void;
}

/**
 * Leaving a form with unsaved changes (Back button, gesture or header back) asks first. Call
 * `allow()` right before navigating away after a successful save.
 */
export function useDiscardGuard(dirty: boolean): { allow(): void; sheet: ReactElement } {
  const navigation = useNavigation() as unknown as Nav;
  const [pending, setPending] = useState<unknown>(null);
  const allowed = useRef(false);
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  useEffect(
    () =>
      navigation.addListener('beforeRemove', (e) => {
        if (!dirtyRef.current || allowed.current) return;
        e.preventDefault();
        setPending(e.data.action);
      }),
    [navigation],
  );

  return {
    allow() {
      allowed.current = true;
    },
    sheet: (
      <ConfirmSheet
        visible={pending !== null}
        title="Discard changes?"
        body="What you typed on this screen will be lost."
        confirmLabel="Discard"
        cancelLabel="Keep editing"
        danger
        onCancel={() => setPending(null)}
        onConfirm={() => {
          const action = pending;
          setPending(null);
          allowed.current = true;
          navigation.dispatch(action);
        }}
      />
    ),
  };
}
