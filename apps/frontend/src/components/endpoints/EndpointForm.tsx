import { useState, type ReactNode } from 'react';
import { Controller, useForm, useWatch, type FieldPath } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { AlertTriangle, Info, Send } from 'lucide-react';
import {
  BODYLESS_METHODS,
  endpointConfigSchema,
  endpointRequestSchema,
  endpointVariableNames,
  HTTP_METHODS,
  type EndpointAuth,
  type EndpointAuthType,
  type EndpointBody,
  type EndpointBodyType,
  type EndpointConfig,
  type EndpointRequest,
  type EndpointVariableSource,
  type EnvironmentView,
} from '@tracelayer/shared';
import { ErrorAlert } from '@/components/Alert';
import { Button } from '@/components/Button';
import { SelectField } from '@/components/SelectField';
import { Tabs } from '@/components/Tabs';
import { TextAreaField } from '@/components/TextAreaField';
import { TextField } from '@/components/TextField';
import { fieldErrors, toApiError } from '@/utils/api-error';
import type { EndpointFormValues } from './endpoint-form-values';
import { KeyValueEditor } from './KeyValueEditor';
import { TagsInput } from './TagsInput';

type FormValues = EndpointFormValues;

const BODY_DEFAULTS: Record<EndpointBodyType, EndpointBody> = {
  none: { type: 'none' },
  json: { type: 'json', content: '{\n  \n}' },
  text: { type: 'text', content: '' },
  form: { type: 'form', fields: [] },
};

const AUTH_DEFAULTS: Record<EndpointAuthType, EndpointAuth> = {
  none: { type: 'none' },
  bearer: { type: 'bearer', token: '' },
  basic: { type: 'basic', username: '', password: '' },
  apiKey: { type: 'apiKey', in: 'header', name: 'X-Api-Key', value: '' },
};

type TabId = 'params' | 'headers' | 'auth' | 'body' | 'settings';

interface EndpointFormProps {
  initialValues: FormValues;
  environments: EnvironmentView[];
  /** Viewers see the configuration but cannot change it. */
  readOnly?: boolean;
  submitLabel: string;
  onSubmit: (config: EndpointConfig) => Promise<void>;
  /** Extra controls in the footer, e.g. a delete button. */
  footer?: ReactNode;
  /**
   * Sends the request as currently shown in the form (including unsaved edits). Omitted for
   * users who cannot run requests.
   */
  onSend?: (request: EndpointRequest, environmentId: string | null) => Promise<void>;
}

const REQUEST_FIELDS = [
  'method',
  'url',
  'headers',
  'queryParams',
  'body',
  'auth',
  'timeoutMs',
] as const;

function joinUrl(baseUrl: string, path: string): string {
  return path.startsWith('/') ? `${baseUrl}${path}` : path;
}

export function EndpointForm({
  initialValues,
  environments,
  readOnly = false,
  submitLabel,
  onSubmit,
  footer,
  onSend,
}: EndpointFormProps) {
  const [tab, setTab] = useState<TabId>('params');
  const [runEnvironmentId, setRunEnvironmentId] = useState<string | null>(
    initialValues.environmentId ?? null,
  );
  const [sending, setSending] = useState(false);
  const {
    register,
    control,
    handleSubmit,
    setError,
    setValue,
    getValues,
    trigger,
    clearErrors,
    formState: { errors, isSubmitting, isDirty },
  } = useForm<FormValues, unknown, EndpointConfig>({
    resolver: zodResolver(endpointConfigSchema),
    defaultValues: initialValues,
  });

  const applyServerErrors = (err: unknown) => {
    const apiError = toApiError(err);
    const fields = Object.entries(fieldErrors(apiError));
    for (const [path, message] of fields) {
      setError(path as FieldPath<FormValues>, { message });
    }
    if (fields.length === 0) setError('root', { message: apiError.message });
  };

  /** Validates only the request part: a request can be sent before the endpoint is named. */
  const send = async () => {
    if (!onSend) return;
    clearErrors('root');
    const parsed = endpointRequestSchema.safeParse(getValues());
    if (!parsed.success) {
      await trigger([...REQUEST_FIELDS]);
      return;
    }
    setSending(true);
    try {
      await onSend(parsed.data, runEnvironmentId);
    } catch (err) {
      applyServerErrors(err);
    } finally {
      setSending(false);
    }
  };

  const values = useWatch({ control });
  const method = values.method ?? 'GET';
  const body = values.body ?? { type: 'none' };
  const auth = values.auth ?? { type: 'none' };
  // With a Send button, previews and variable checks follow the environment it will run in.
  const environment = environments.find(
    (e) => e.id === (onSend ? runEnvironmentId : values.environmentId),
  );

  const submit = handleSubmit(async (config) => {
    try {
      await onSubmit(config);
    } catch (err) {
      applyServerErrors(err);
    }
  });

  // ─── Variable usage ────────────────────────────────────────────────────────
  const variableNames = endpointVariableNames(values as EndpointVariableSource);
  const definedKeys = new Set(environment?.variables.map((v) => v.key) ?? []);
  const missing = environment ? variableNames.filter((name) => !definedKeys.has(name)) : [];

  const tabs = [
    {
      id: 'params' as const,
      label: 'Params',
      badge: values.queryParams?.length ? String(values.queryParams.length) : undefined,
      flagged: Boolean(errors.queryParams),
    },
    {
      id: 'headers' as const,
      label: 'Headers',
      badge: values.headers?.length ? String(values.headers.length) : undefined,
      flagged: Boolean(errors.headers),
    },
    { id: 'auth' as const, label: 'Auth', flagged: Boolean(errors.auth) },
    { id: 'body' as const, label: 'Body', flagged: Boolean(errors.body) },
    {
      id: 'settings' as const,
      label: 'Settings',
      flagged: Boolean(
        errors.environmentId || errors.timeoutMs || errors.expectedStatus || errors.tags,
      ),
    },
  ];

  const nestedError = (error: unknown, key: string): string | undefined =>
    (error as Record<string, { message?: string }> | undefined)?.[key]?.message;

  return (
    <form onSubmit={submit} noValidate>
      <fieldset disabled={readOnly || isSubmitting} className="flex flex-col gap-6">
        <legend className="sr-only">Endpoint configuration</legend>
        {errors.root?.message && <ErrorAlert>{errors.root.message}</ErrorAlert>}

        <div className="grid gap-4 sm:grid-cols-2">
          <TextField
            label="Name"
            placeholder="List orders"
            autoComplete="off"
            error={errors.name?.message}
            {...register('name')}
          />
          <TextField
            label="Description"
            placeholder="Optional"
            autoComplete="off"
            error={errors.description?.message}
            {...register('description')}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          {/* One row on wider screens; on phones, method + URL, then environment + Send. */}
          <div className="flex flex-wrap gap-2 sm:flex-nowrap">
            <div className="w-32 shrink-0">
              <SelectField
                label="Method"
                hideLabel
                className="w-full font-mono font-semibold"
                options={HTTP_METHODS.map((m) => ({ value: m, label: m }))}
                {...register('method')}
              />
            </div>
            <div className="min-w-0 flex-1 basis-[calc(100%-8.5rem)] sm:basis-0">
              <TextField
                label="URL"
                hideLabel
                placeholder="/orders/{{ORDER_ID}}  or  https://api.example.com/orders"
                autoComplete="off"
                spellCheck={false}
                className="w-full font-mono"
                error={errors.url?.message}
                {...register('url')}
              />
            </div>
            {onSend && (
              <>
                <div className="min-w-0 flex-1 sm:w-36 sm:flex-none">
                  <SelectField
                    label="Run in environment"
                    hideLabel
                    className="w-full"
                    value={runEnvironmentId ?? ''}
                    onChange={(e) => setRunEnvironmentId(e.target.value || null)}
                    options={[
                      { value: '', label: 'No environment' },
                      ...environments.map((e) => ({ value: e.id, label: e.name })),
                    ]}
                  />
                </div>
                <Button
                  onClick={() => void send()}
                  loading={sending}
                  className="shrink-0 self-start"
                >
                  <Send className="size-4" aria-hidden="true" />
                  Send
                </Button>
              </>
            )}
          </div>
          {environment?.baseUrl && values.url?.startsWith('/') && (
            <p className="truncate font-mono text-xs text-fg-subtle">
              {environment.name}: {joinUrl(environment.baseUrl, values.url)}
            </p>
          )}
          {environment && !environment.baseUrl && values.url?.startsWith('/') && (
            <p className="text-xs text-warn">
              {environment.name} has no base URL, so this relative path cannot run there yet.
            </p>
          )}
        </div>

        <Tabs
          label="Request configuration"
          tabs={tabs}
          selected={tab}
          onSelect={(id) => setTab(id as TabId)}
        >
          {tab === 'params' && (
            <KeyValueEditor
              itemLabel="Parameter"
              name="queryParams"
              control={control}
              register={register}
              errors={errors.queryParams}
            />
          )}

          {tab === 'headers' && (
            <div className="flex flex-col gap-3">
              <KeyValueEditor
                itemLabel="Header"
                name="headers"
                control={control}
                register={register}
                errors={errors.headers}
                keyPlaceholder="Header-Name"
              />
              <p className="flex items-start gap-1.5 text-xs text-fg-subtle">
                <Info className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
                Credential headers such as Authorization must use a variable, e.g.
                <code className="font-mono">Bearer {'{{API_TOKEN}}'}</code>. Store the value as a
                secret in the environment.
              </p>
            </div>
          )}

          {tab === 'auth' && (
            <div className="flex max-w-xl flex-col gap-4">
              <SelectField
                label="Type"
                value={auth.type}
                onChange={(e) =>
                  setValue('auth', AUTH_DEFAULTS[e.target.value as EndpointAuthType], {
                    shouldDirty: true,
                  })
                }
                options={[
                  { value: 'none', label: 'No authentication' },
                  { value: 'bearer', label: 'Bearer token' },
                  { value: 'basic', label: 'Basic auth' },
                  { value: 'apiKey', label: 'API key' },
                ]}
              />
              {auth.type === 'bearer' && (
                <TextField
                  label="Token"
                  placeholder="{{API_TOKEN}}"
                  className="font-mono"
                  autoComplete="off"
                  error={nestedError(errors.auth, 'token')}
                  {...register('auth.token' as FieldPath<FormValues>)}
                />
              )}
              {auth.type === 'basic' && (
                <>
                  <TextField
                    label="Username"
                    autoComplete="off"
                    className="font-mono"
                    error={nestedError(errors.auth, 'username')}
                    {...register('auth.username' as FieldPath<FormValues>)}
                  />
                  <TextField
                    label="Password"
                    placeholder="{{API_PASSWORD}}"
                    autoComplete="off"
                    className="font-mono"
                    error={nestedError(errors.auth, 'password')}
                    {...register('auth.password' as FieldPath<FormValues>)}
                  />
                </>
              )}
              {auth.type === 'apiKey' && (
                <>
                  <SelectField
                    label="Send in"
                    options={[
                      { value: 'header', label: 'Header' },
                      { value: 'query', label: 'Query parameter' },
                    ]}
                    {...register('auth.in' as FieldPath<FormValues>)}
                  />
                  <TextField
                    label="Name"
                    className="font-mono"
                    autoComplete="off"
                    error={nestedError(errors.auth, 'name')}
                    {...register('auth.name' as FieldPath<FormValues>)}
                  />
                  <TextField
                    label="Value"
                    placeholder="{{API_KEY}}"
                    className="font-mono"
                    autoComplete="off"
                    error={nestedError(errors.auth, 'value')}
                    {...register('auth.value' as FieldPath<FormValues>)}
                  />
                </>
              )}
              {auth.type !== 'none' && (
                <p className="text-xs text-fg-subtle">
                  Credentials are never stored on the endpoint: reference a variable such as{' '}
                  <code className="font-mono">{'{{API_TOKEN}}'}</code> and keep its value as a
                  secret in each environment.
                </p>
              )}
            </div>
          )}

          {tab === 'body' && (
            <div className="flex flex-col gap-4">
              {BODYLESS_METHODS.includes(method) ? (
                <p className="text-sm text-fg-subtle">{method} requests do not have a body.</p>
              ) : (
                <SelectField
                  label="Body type"
                  value={body.type}
                  onChange={(e) =>
                    setValue('body', BODY_DEFAULTS[e.target.value as EndpointBodyType], {
                      shouldDirty: true,
                    })
                  }
                  className="max-w-xs"
                  options={[
                    { value: 'none', label: 'None' },
                    { value: 'json', label: 'JSON' },
                    { value: 'text', label: 'Text' },
                    { value: 'form', label: 'Form (URL-encoded)' },
                  ]}
                />
              )}
              {errors.body?.message && <p className="text-xs text-fail">{errors.body.message}</p>}
              {(body.type === 'json' || body.type === 'text') && (
                <TextAreaField
                  label={body.type === 'json' ? 'JSON' : 'Text'}
                  rows={10}
                  spellCheck={false}
                  className="font-mono text-xs"
                  hint={
                    body.type === 'json'
                      ? 'Variables may appear anywhere, e.g. {"qty": {{QTY}}}.'
                      : undefined
                  }
                  error={nestedError(errors.body, 'content')}
                  {...register('body.content' as FieldPath<FormValues>)}
                />
              )}
              {body.type === 'form' && (
                <KeyValueEditor
                  itemLabel="Field"
                  name={'body.fields' as 'queryParams'}
                  control={control}
                  register={register}
                  errors={(errors.body as { fields?: unknown } | undefined)?.fields}
                />
              )}
            </div>
          )}

          {tab === 'settings' && (
            <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
              <Controller
                control={control}
                name="environmentId"
                render={({ field }) => (
                  <SelectField
                    label="Default environment"
                    value={field.value ?? ''}
                    onChange={(e) => field.onChange(e.target.value || null)}
                    error={errors.environmentId?.message}
                    options={[
                      { value: '', label: 'None' },
                      ...environments.map((e) => ({ value: e.id, label: e.name })),
                    ]}
                  />
                )}
              />
              <TextField
                label="Timeout (ms)"
                type="number"
                min={1000}
                max={30000}
                step={500}
                error={errors.timeoutMs?.message}
                {...register('timeoutMs', { valueAsNumber: true })}
              />
              <TextField
                label="Expected status"
                type="number"
                min={100}
                max={599}
                placeholder="Any 2xx"
                hint="Leave empty to accept any 2xx response."
                error={errors.expectedStatus?.message}
                {...register('expectedStatus', {
                  setValueAs: (v: string) => (v === '' || v === null ? null : Number(v)),
                })}
              />
              <Controller
                control={control}
                name="tags"
                render={({ field }) => (
                  <TagsInput
                    value={field.value ?? []}
                    onChange={field.onChange}
                    error={
                      errors.tags?.message ??
                      (Array.isArray(errors.tags)
                        ? errors.tags.find((e) => e?.message)?.message
                        : undefined)
                    }
                  />
                )}
              />
            </div>
          )}
        </Tabs>

        {variableNames.length > 0 && (
          <div className="rounded-md border border-line bg-surface px-3 py-2.5 text-xs">
            <p className="text-fg-muted">
              Uses variables:{' '}
              {variableNames.map((name, i) => (
                <span key={name}>
                  {i > 0 && ', '}
                  <code className="font-mono text-fg">{name}</code>
                </span>
              ))}
            </p>
            {!environment ? (
              <p className="mt-1 text-fg-subtle">
                {onSend
                  ? 'Choose an environment to run in to check they are defined.'
                  : 'Choose a default environment in Settings to check they are defined.'}
              </p>
            ) : missing.length > 0 ? (
              <p className="mt-1 flex items-center gap-1 text-warn">
                <AlertTriangle className="size-3.5" aria-hidden="true" />
                Not defined in {environment.name}: {missing.join(', ')}
              </p>
            ) : (
              <p className="mt-1 text-ok">All defined in {environment.name}.</p>
            )}
          </div>
        )}
      </fieldset>

      {!readOnly && (
        <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-line pt-4">
          <div>{footer}</div>
          <Button type="submit" loading={isSubmitting} disabled={!isDirty}>
            {submitLabel}
          </Button>
        </div>
      )}
    </form>
  );
}
