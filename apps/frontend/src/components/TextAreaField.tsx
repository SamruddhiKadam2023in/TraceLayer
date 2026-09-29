import { useId, type ComponentProps } from 'react';

interface TextAreaFieldProps extends ComponentProps<'textarea'> {
  label: string;
  error?: string;
  hint?: string;
}

export function TextAreaField({
  label,
  error,
  hint,
  id,
  className = '',
  ...props
}: TextAreaFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const hintId = hint ? `${fieldId}-hint` : undefined;
  const errorId = error ? `${fieldId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={fieldId} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={fieldId}
        rows={3}
        aria-invalid={error ? true : undefined}
        aria-describedby={[errorId, hintId].filter(Boolean).join(' ') || undefined}
        className={`resize-y rounded-md border bg-surface px-3 py-2 text-sm placeholder:text-fg-subtle ${
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
