import { useId, type ComponentProps } from 'react';

interface SelectFieldProps extends ComponentProps<'select'> {
  label: string;
  /** Visually hide the label (it is still announced), e.g. inside a table row. */
  hideLabel?: boolean;
  error?: string;
  options: { value: string; label: string }[];
}

export function SelectField({
  label,
  hideLabel = false,
  error,
  options,
  id,
  className = '',
  ...props
}: SelectFieldProps) {
  const generatedId = useId();
  const selectId = id ?? generatedId;
  const errorId = error ? `${selectId}-error` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={selectId} className={hideLabel ? 'sr-only' : 'text-sm font-medium'}>
        {label}
      </label>
      <select
        id={selectId}
        aria-invalid={error ? true : undefined}
        aria-describedby={errorId}
        className={`rounded-md border bg-surface px-2.5 py-2 text-sm disabled:opacity-60 ${
          error ? 'border-fail' : 'border-line'
        } ${className}`}
        {...props}
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {error && (
        <p id={errorId} className="text-xs text-fail">
          {error}
        </p>
      )}
    </div>
  );
}
