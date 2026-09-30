import { z } from 'zod';

// ─── Limits ──────────────────────────────────────────────────────────────────

export const MAX_PROJECTS_PER_WORKSPACE = 50;
export const MAX_ENVIRONMENTS_PER_PROJECT = 10;
export const MAX_VARIABLES_PER_ENVIRONMENT = 50;

/** Created with every new project. Base URLs start empty. */
export const DEFAULT_ENVIRONMENTS = ['Development', 'Staging', 'Production'] as const;

// ─── Projects ────────────────────────────────────────────────────────────────

export const projectNameSchema = z
  .string()
  .trim()
  .min(1, 'Project name is required')
  .max(100, 'Project name is too long');

/** Empty text or null means "no description" (forms send null for an empty field). */
const descriptionSchema = z
  .string()
  .trim()
  .max(500, 'Description is too long')
  .transform((v) => (v === '' ? null : v));

export const createProjectSchema = z.object({
  workspaceId: z.uuid('Invalid workspace'),
  name: projectNameSchema,
  description: descriptionSchema.nullable().optional(),
});
export type CreateProjectInput = z.input<typeof createProjectSchema>;

export const updateProjectSchema = z
  .object({
    name: projectNameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .refine((v) => v.name !== undefined || v.description !== undefined, 'Nothing to update');
export type UpdateProjectInput = z.input<typeof updateProjectSchema>;

export const listProjectsQuerySchema = z.object({ workspaceId: z.uuid('Invalid workspace') });

// ─── Environments ────────────────────────────────────────────────────────────

export const environmentNameSchema = z
  .string()
  .trim()
  .min(1, 'Environment name is required')
  .max(50, 'Environment name is too long');

/**
 * An http(s) URL without credentials, stored without a trailing slash. Empty means "not set".
 * Only the format is checked here; whether the host may be called is decided when a request
 * is actually made (SSRF protection, Phase 7).
 */
export const baseUrlSchema = z
  .string()
  .trim()
  .max(2048, 'URL is too long')
  .transform((v, ctx) => {
    if (v === '') return null;
    let url: URL;
    try {
      url = new URL(v);
    } catch {
      ctx.addIssue({ code: 'custom', message: 'Enter a full URL, e.g. https://api.example.com' });
      return z.NEVER;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      ctx.addIssue({ code: 'custom', message: 'Only http and https URLs are supported' });
      return z.NEVER;
    }
    if (url.username || url.password) {
      ctx.addIssue({
        code: 'custom',
        message: 'Do not put credentials in the URL; use a secret variable instead',
      });
      return z.NEVER;
    }
    if (url.search || url.hash) {
      ctx.addIssue({ code: 'custom', message: 'A base URL cannot contain ? or #' });
      return z.NEVER;
    }
    return url.href.replace(/\/+$/, '');
  });

export const createEnvironmentSchema = z.object({
  name: environmentNameSchema,
  baseUrl: baseUrlSchema.optional(),
});
export type CreateEnvironmentInput = z.input<typeof createEnvironmentSchema>;

export const updateEnvironmentSchema = z
  .object({
    name: environmentNameSchema.optional(),
    baseUrl: baseUrlSchema.optional(),
  })
  .refine((v) => v.name !== undefined || v.baseUrl !== undefined, 'Nothing to update');
export type UpdateEnvironmentInput = z.input<typeof updateEnvironmentSchema>;

// ─── Environment variables ───────────────────────────────────────────────────

export const variableKeySchema = z
  .string()
  .trim()
  .min(1, 'Key is required')
  .max(100, 'Key is too long')
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*$/,
    'Use letters, digits and underscores, not starting with a digit',
  );

export const variableValueSchema = z.string().max(4096, 'Value is too long');

export const createVariableSchema = z.object({
  key: variableKeySchema,
  value: variableValueSchema,
  isSecret: z.boolean().default(false),
});
export type CreateVariableInput = z.input<typeof createVariableSchema>;

/**
 * Omitting `value` keeps the stored value. Turning a secret into a plain variable requires a
 * new value, because a secret's value is never revealed.
 */
export const updateVariableSchema = z
  .object({
    key: variableKeySchema.optional(),
    value: variableValueSchema.optional(),
    isSecret: z.boolean().optional(),
  })
  .refine(
    (v) => v.key !== undefined || v.value !== undefined || v.isSecret !== undefined,
    'Nothing to update',
  );
export type UpdateVariableInput = z.input<typeof updateVariableSchema>;

// ─── Response types ──────────────────────────────────────────────────────────

export interface ProjectView {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  createdBy: { id: string; name: string } | null;
  environmentCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentVariableView {
  id: string;
  key: string;
  isSecret: boolean;
  /** Always null for secrets: their values never leave the server. */
  value: string | null;
  updatedAt: string;
}

export interface EnvironmentView {
  id: string;
  projectId: string;
  name: string;
  baseUrl: string | null;
  variables: EnvironmentVariableView[];
  createdAt: string;
  updatedAt: string;
}
