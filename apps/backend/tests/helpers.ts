import type { Response } from 'supertest';
import { prisma } from '../src/lib/prisma';

/** Empties every table touched by the tests. `CASCADE` follows foreign keys. */
export async function resetDatabase(): Promise<void> {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE users, refresh_tokens CASCADE');
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
