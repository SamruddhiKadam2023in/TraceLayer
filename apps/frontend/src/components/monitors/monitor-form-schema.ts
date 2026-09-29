import { z } from 'zod';
import {
  ASSERTION_OPERATORS,
  assertionPathSchema,
  MAX_ASSERTIONS,
  monitorFieldSchemas,
  monitorTypeRules,
  type MonitorConfig,
} from '@tracelayer/shared';
import { formatAssertionValue, parseAssertionValue } from './assertion-values';

/**
 * The form's version of the monitor schema. Assertion values are edited as text and converted
 * to JSON on submit (the API's schema types them as arbitrary JSON, which form typing cannot
 * handle); every other field uses the shared schemas unchanged.
 */
const formAssertionSchema = z
  .object({
    path: assertionPathSchema,
    operator: z.enum(ASSERTION_OPERATORS),
    value: z.string(),
  })
  .refine((a) => a.operator === 'exists' || a.operator === 'notExists' || a.value.trim() !== '', {
    path: ['value'],
    message: 'Enter a value to compare with',
  });

export const monitorFormSchema = z
  .object({
    ...monitorFieldSchemas,
    assertions: z
      .array(formAssertionSchema)
      .max(MAX_ASSERTIONS, `At most ${MAX_ASSERTIONS} checks`),
  })
  .superRefine(monitorTypeRules);

export type MonitorFormValues = z.input<typeof monitorFormSchema>;
export type MonitorFormOutput = z.output<typeof monitorFormSchema>;

export function toFormValues(config: MonitorConfig | MonitorFormDefaults): MonitorFormValues {
  return {
    ...config,
    assertions: config.assertions.map((a) => ({
      path: a.path,
      operator: a.operator,
      value: formatAssertionValue(a.value),
    })),
  };
}

/** Settings that only apply to other monitor types are cleared before saving. */
export function toMonitorConfig(values: MonitorFormOutput): MonitorConfig {
  return {
    ...values,
    latencyThresholdMs: values.type === 'PERFORMANCE' ? values.latencyThresholdMs : null,
    expectedStatus: values.type === 'AVAILABILITY' ? null : values.expectedStatus,
    assertions:
      values.type === 'RESPONSE_VALIDATION'
        ? values.assertions.map((a) => ({
            path: a.path,
            operator: a.operator,
            ...(a.operator === 'exists' || a.operator === 'notExists'
              ? {}
              : { value: parseAssertionValue(a.value) as never }),
          }))
        : [],
  };
}

export type MonitorFormDefaults = Omit<MonitorConfig, 'endpointId' | 'environmentId'> & {
  endpointId: string;
  environmentId: string;
};
