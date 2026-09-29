import request from 'supertest';
import type { Express } from 'express';
import type { Response } from 'supertest';
import { prisma } from '../src/lib/prisma';

/** Empties every table touched by the tests. `CASCADE` follows foreign keys. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE users, refresh_tokens, workspaces, workspace_members CASCADE',
  );
}

/** Returns the raw Set-Cookie header for a cookie, or undefined if it was not set. */
export function getSetCookie(res: Response, name: string): string | undefined {
  const header = res.headers['set-cookie'] as unknown;
  const cookies = Array.isArray(header) ? (header as string[]) : [];
  return cookies.find((c) => c.startsWith(`${name}=`));
}

/** The `name=value` part of a Set-Cookie header, ready to send back in a Cookie header. */
export function cookiePair(setCookie: string | undefined): string {
  if (!setCookie) throw new Error('cookie was not set');
  return setCookie.split(';')[0] ?? '';
}

export interface TestUser {
  id: string;
  email: string;
  token: string;
  /** Headers for an authenticated request. */
  auth: { Authorization: string };
}

/** Registers a user through the API and returns their access token. */
export async function createTestUser(app: Express, name: string): Promise<TestUser> {
  const email = `${name.toLowerCase().replace(/\s+/g, '.')}@example.com`;
  const res = await request(app)
    .post('/api/auth/register')
    .send({ name, email, password: 'password-123', confirmPassword: 'password-123' });
  if (res.status !== 201) throw new Error(`register failed: ${JSON.stringify(res.body)}`);
  const token = res.body.data.accessToken as string;
  return { id: res.body.data.user.id, email, token, auth: { Authorization: `Bearer ${token}` } };
}
