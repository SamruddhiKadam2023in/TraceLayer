import { useId, type ComponentProps } from 'react';

interface TextFieldProps extends ComponentProps<'input'> {
  label: string;
  /** Visually hide the label (it is still announced). */
  hideLabel?: boolean;
  error?: string;
  hint?: string;
}

/** Labelled input whose error and hint are announced through aria-describedby. */
export function TextField({
  label,
  hideLabel = false,
  error,
  hint,
  id,
  className = '',
  ...props
}: TextFieldProps) {
  const generatedId = useId();
  const inputId = id ?? generatedId;
  const hintId = hint ? `${inputId}-hint` : undefined;
  const errorId = error ? `${inputId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={inputId} className={hideLabel ? 'sr-only' : 'text-sm font-medium'}>
        {label}
      </label>
      <input
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
        className={`rounded-md border bg-surface px-3 py-2 text-sm placeholder:text-fg-subtle focus-visible:outline-2 focus-visible:outline-offset-0 ${
          error ? 'border-fail' : 'border-line'
        } ${className}`}
        {...props}
      />
      {error ? (
        <p id={errorId} className="text-xs text-fail">
          {error}
        </p>
      ) : (
        hint && (
          <p id={hintId} className="text-xs text-fg-subtle">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
