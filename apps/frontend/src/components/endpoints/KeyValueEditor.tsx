import {
  useFieldArray,
  type ArrayPath,
  type Control,
  type FieldValues,
  type Path,
  type UseFormRegister,
} from 'react-hook-form';
import { Plus, X } from 'lucide-react';
import { MAX_KEY_VALUE_ROWS } from '@tracelayer/shared';

interface RowErrors {
  key?: { message?: string };
  value?: { message?: string };
}

interface KeyValueEditorProps<T extends FieldValues> {
  /** Used in accessible labels, e.g. "Header" → "Header 1 name". */
  itemLabel: string;
  name: ArrayPath<T>;
  control: Control<T>;
  register: UseFormRegister<T>;
  errors: unknown;
  keyPlaceholder?: string;
  valuePlaceholder?: string;
}

/** Editable rows of enabled / name / value, for headers, query parameters and form fields. */
export function KeyValueEditor<T extends FieldValues>({
  itemLabel,
  name,
  control,
  register,
  errors,
  keyPlaceholder = 'Name',
  valuePlaceholder = 'Value',
}: KeyValueEditorProps<T>) {
  const { fields, append, remove } = useFieldArray({ control, name });
  const rowErrors = (Array.isArray(errors) ? errors : []) as (RowErrors | undefined)[];
  const field = (index: number, part: 'key' | 'value' | 'enabled') =>
    `${name}.${index}.${part}` as Path<T>;

  return (
    <div className="flex flex-col gap-2">
      {fields.length === 0 && <p className="text-sm text-fg-subtle">None.</p>}
      {fields.map((row, index) => {
        const error = rowErrors[index];
        const label = `${itemLabel} ${index + 1}`;
        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <input
                type="checkbox"
                aria-label={`${label} enabled`}
                className="size-4 shrink-0 accent-accent"
                {...register(field(index, 'enabled'))}
              />
              <input
                aria-label={`${label} name`}
                aria-invalid={error?.key ? true : undefined}
                placeholder={keyPlaceholder}
                spellCheck={false}
                autoComplete="off"
                className={`w-2/5 min-w-0 rounded-md border bg-surface px-2.5 py-1.5 font-mono text-xs ${
                  error?.key ? 'border-fail' : 'border-line'
                }`}
                {...register(field(index, 'key'))}
              />
              <input
                aria-label={`${label} value`}
                aria-invalid={error?.value ? true : undefined}
                placeholder={valuePlaceholder}
                spellCheck={false}
                autoComplete="off"
                className={`min-w-0 flex-1 rounded-md border bg-surface px-2.5 py-1.5 font-mono text-xs ${
                  error?.value ? 'border-fail' : 'border-line'
                }`}
                {...register(field(index, 'value'))}
              />
              <button
                type="button"
                onClick={() => remove(index)}
                aria-label={`Remove ${label.toLowerCase()}`}
                className="rounded-md p-1.5 text-fg-subtle hover:bg-surface-2 hover:text-fg"
              >
                <X className="size-3.5" aria-hidden="true" />
              </button>
            </div>
            {(error?.key?.message ?? error?.value?.message) && (
              <p className="pl-6 text-xs text-fail">
                {error?.key?.message ?? error?.value?.message}
              </p>
            )}
          </div>
        );
      })}
      <div>
        <button
          type="button"
          onClick={() =>
            append({ key: '', value: '', enabled: true } as Parameters<typeof append>[0])
          }
          disabled={fields.length >= MAX_KEY_VALUE_ROWS}
          className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs font-medium text-fg-muted hover:bg-surface-2 hover:text-fg disabled:opacity-50"
        >
          <Plus className="size-3.5" aria-hidden="true" />
          Add {itemLabel.toLowerCase()}
        </button>
      </div>
    </div>
  );
}
