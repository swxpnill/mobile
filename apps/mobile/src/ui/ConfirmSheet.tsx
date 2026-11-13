import { Button } from './Button';
import { Sheet } from './Sheet';
import { Text } from './Text';

/** A yes/no question in the app's own sheet (never a native alert): danger or plain confirm. */
export function ConfirmSheet({
  visible,
  title,
  body,
  confirmLabel,
  cancelLabel = 'Cancel',
  danger,
  busy,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm(): void;
  onCancel(): void;
}) {
  return (
    <Sheet visible={visible} title={title} onClose={onCancel} busy={busy}>
      {body ? <Text color="tx2">{body}</Text> : null}
      <Button variant={danger ? 'danger' : 'primary'} loading={busy} onPress={onConfirm}>
        {confirmLabel}
      </Button>
      <Button variant="secondary" disabled={busy} onPress={onCancel}>
        {cancelLabel}
      </Button>
    </Sheet>
  );
}
