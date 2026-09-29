import type { z } from 'zod';
import { DEFAULT_TIMEOUT_MS, type endpointConfigSchema } from '@tracelayer/shared';

export type EndpointFormValues = z.input<typeof endpointConfigSchema>;

/** Starting values for a new endpoint. */
export const EMPTY_ENDPOINT: EndpointFormValues = {
  name: '',
  description: '',
  method: 'GET',
  url: '',
  environmentId: null,
  headers: [],
  queryParams: [],
  body: { type: 'none' },
  auth: { type: 'none' },
  timeoutMs: DEFAULT_TIMEOUT_MS,
  expectedStatus: null,
  tags: [],
};
