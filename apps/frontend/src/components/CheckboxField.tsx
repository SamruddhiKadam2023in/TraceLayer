import { useId, type ComponentProps } from 'react';

interface CheckboxFieldProps extends Omit<ComponentProps<'input'>, 'type'> {
  label: string;
  description?: string;
}

export function CheckboxField({ label, description, id, ...props }: CheckboxFieldProps) {
  const generatedId = useId();
  const fieldId = id ?? generatedId;
  const descriptionId = description ? `${fieldId}-description` : undefined;

  return (
    <div className="flex items-start gap-2.5">
      <input
        id={fieldId}
        type="checkbox"
        aria-describedby={descriptionId}
        className="mt-0.5 size-4 rounded border-line accent-accent"
        {...props}
      />
      <div>
        <label htmlFor={fieldId} className="text-sm font-medium">
          {label}
        </label>
        {description && (
          <p id={descriptionId} className="text-xs text-fg-subtle">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
