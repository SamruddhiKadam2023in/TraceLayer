import { useState, type ReactNode } from 'react';
import { toApiError } from '@/utils/api-error';
import { ErrorAlert } from './Alert';
import { Button } from './Button';
import { Modal } from './Modal';
import { TextField } from './TextField';

interface ConfirmDialogProps {
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Destructive actions get a red confirm button. */
  destructive?: boolean;
  /** For irreversible actions: the user must type this exact text to enable the button. */
  confirmationText?: string;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

/** Asks before an action; shows progress and any error inside the dialog. */
export function ConfirmDialog({
  title,
  children,
  confirmLabel,
  destructive = false,
  confirmationText,
  onConfirm,
  onClose,
}: ConfirmDialogProps) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const confirmed = !confirmationText || typed === confirmationText;

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
    } catch (err) {
      setError(toApiError(err).message);
      setBusy(false);
    }
  };

  return (
    <Modal title={title} onClose={busy ? () => undefined : onClose}>
      <div className="flex flex-col gap-4">
        <div className="text-sm text-fg-muted">{children}</div>
        {confirmationText && (
          <TextField
            label={`Type ${confirmationText} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        {error && <ErrorAlert>{error}</ErrorAlert>}
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            variant={destructive ? 'danger' : 'primary'}
            onClick={confirm}
            loading={busy}
            disabled={!confirmed}
          >
            {confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
