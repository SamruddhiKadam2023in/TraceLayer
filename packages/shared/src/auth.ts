import { z } from 'zod';

export const PASSWORD_MIN_LENGTH = 8;
/** bcrypt ignores everything past 72 bytes, so longer passwords would be silently truncated. */
export const PASSWORD_MAX_BYTES = 72;

/** UTF-8 byte length, without depending on DOM or Node globals. */
function utf8Length(value: string): number {
  let bytes = 0;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long')
  .pipe(z.email('Enter a valid email address'));

const passwordMaxBytes = (schema: z.ZodString) =>
  schema.refine((value) => utf8Length(value) <= PASSWORD_MAX_BYTES, {
    message: `Password must be at most ${PASSWORD_MAX_BYTES} bytes`,
  });

export const passwordSchema = passwordMaxBytes(
  z
    .string()
    .min(PASSWORD_MIN_LENGTH, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`),
);

export const registerSchema = z
  .object({
    name: z.string().trim().min(1, 'Name is required').max(100, 'Name is too long'),
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string().min(1, 'Confirm your password'),
  })
  .refine((data) => data.password === data.confirmPassword, {
    path: ['confirmPassword'],
    message: 'Passwords do not match',
  });
export type RegisterInput = z.input<typeof registerSchema>;

export const loginSchema = z.object({
  email: emailSchema,
  password: passwordMaxBytes(z.string().min(1, 'Password is required')),
});
export type LoginInput = z.input<typeof loginSchema>;

/** The public view of a user. Never includes the password hash. */
export interface AuthUser {
  id: string;
  name: string;
  email: string;
  createdAt: string;
}

/** Returned by register, login and refresh. The refresh token travels only as an httpOnly cookie. */
export interface AuthSession {
  user: AuthUser;
  accessToken: string;
  /** Access-token lifetime in seconds. */
  expiresIn: number;
}
