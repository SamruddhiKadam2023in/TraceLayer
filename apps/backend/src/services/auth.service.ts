import bcrypt from 'bcryptjs';
import { Prisma, type User } from '@tracelayer/db';
import type { AuthSession, AuthUser, LoginInput, RegisterInput } from '@tracelayer/shared';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import {
  deleteExpiredRefreshTokens,
  issueRefreshToken,
  revokeRefreshToken,
  rotateRefreshToken,
  signAccessToken,
  type ClientInfo,
  type IssuedRefreshToken,
} from './token.service';

/** A session plus the refresh token, which the controller moves into a cookie. */
export interface SessionResult {
  session: AuthSession;
  refreshToken: IssuedRefreshToken;
}

type RegisterData = Omit<RegisterInput, 'confirmPassword'>;

export function toAuthUser(user: User): AuthUser {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    createdAt: user.createdAt.toISOString(),
  };
}

function buildSession(user: User, refreshToken: IssuedRefreshToken): SessionResult {
  return {
    session: {
      user: toAuthUser(user),
      accessToken: signAccessToken(user.id),
      expiresIn: env.JWT_ACCESS_TTL,
    },
    refreshToken,
  };
}

function emailTakenError(): AppError {
  return new AppError('CONFLICT', 'An account with this email already exists', [
    { path: 'email', message: 'An account with this email already exists' },
  ]);
}

// Compared against when the email is unknown, so a login takes the same time whether or not
// the account exists and response timing cannot be used to discover registered emails.
let dummyHash: Promise<string> | undefined;
function getDummyHash(): Promise<string> {
  dummyHash ??= bcrypt.hash('tracelayer-timing-equaliser', env.BCRYPT_ROUNDS);
  return dummyHash;
}

export async function register(input: RegisterData, client: ClientInfo): Promise<SessionResult> {
  const existing = await prisma.user.findUnique({
    where: { email: input.email },
    select: { id: true },
  });
  if (existing) throw emailTakenError();

  const passwordHash = await bcrypt.hash(input.password, env.BCRYPT_ROUNDS);
  try {
    const user = await prisma.user.create({
      data: { name: input.name, email: input.email, passwordHash },
    });
    return buildSession(user, await issueRefreshToken(user.id, client));
  } catch (err) {
    // Two simultaneous registrations for one email: the unique constraint decides.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      throw emailTakenError();
    }
    throw err;
  }
}

export async function login(input: LoginInput, client: ClientInfo): Promise<SessionResult> {
  const user = await prisma.user.findUnique({ where: { email: input.email } });
  const valid = await bcrypt.compare(input.password, user?.passwordHash ?? (await getDummyHash()));
  if (!user || !valid) throw AppError.unauthenticated('Invalid email or password');

  await deleteExpiredRefreshTokens(user.id);
  return buildSession(user, await issueRefreshToken(user.id, client));
}

export async function refresh(token: string, client: ClientInfo): Promise<SessionResult> {
  const { user, refreshToken } = await rotateRefreshToken(token, client);
  return buildSession(user, refreshToken);
}

export async function logout(token: string | undefined): Promise<void> {
  if (token) await revokeRefreshToken(token);
}

export async function getCurrentUser(userId: string): Promise<AuthUser> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  // A valid token for a deleted account is still unauthenticated.
  if (!user) throw AppError.unauthenticated('Account no longer exists');
  return toAuthUser(user);
}

export function missingSessionError(): AppError {
  return AppError.unauthenticated('No active session');
}
