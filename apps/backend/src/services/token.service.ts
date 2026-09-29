import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Prisma, User } from '@tracelayer/db';
import { env } from '../config/env';
import { prisma } from '../lib/prisma';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';

const JWT_ISSUER = 'tracelayer';
const JWT_AUDIENCE = 'tracelayer-api';
const REFRESH_TOKEN_BYTES = 32;
const DAY_MS = 86_400_000;

/** Request context stored alongside a refresh token, to identify sessions later. */
export interface ClientInfo {
  userAgent?: string;
  ipAddress?: string;
}

export interface IssuedRefreshToken {
  token: string;
  expiresAt: Date;
}

// ─── Access tokens ───────────────────────────────────────────────────────────

export function signAccessToken(userId: string): string {
  return jwt.sign({}, env.JWT_SECRET, {
    algorithm: 'HS256',
    subject: userId,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
    expiresIn: env.JWT_ACCESS_TTL,
  });
}

/** Returns the user id of a valid access token; throws UNAUTHENTICATED otherwise. */
export function verifyAccessToken(token: string): string {
  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      // Pinning the algorithm rejects `alg: none` and algorithm-confusion tokens.
      algorithms: ['HS256'],
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    });
    if (typeof payload === 'string' || !payload.sub) throw new Error('missing subject');
    return payload.sub;
  } catch (err) {
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthenticated('Access token expired');
    }
    throw AppError.unauthenticated('Invalid access token');
  }
}

// ─── Refresh tokens ──────────────────────────────────────────────────────────

/** Keyed hash: a leaked database alone is not enough to recognise or forge a valid token. */
function hashRefreshToken(token: string): string {
  return createHmac('sha256', env.JWT_REFRESH_SECRET).update(token).digest('hex');
}

function truncate(value: string | undefined, max: number): string | null {
  return value ? value.slice(0, max) : null;
}

export async function issueRefreshToken(
  userId: string,
  client: ClientInfo,
  familyId: string = randomUUID(),
  db: Prisma.TransactionClient = prisma,
): Promise<IssuedRefreshToken> {
  const token = randomBytes(REFRESH_TOKEN_BYTES).toString('base64url');
  const expiresAt = new Date(Date.now() + env.JWT_REFRESH_TTL_DAYS * DAY_MS);
  await db.refreshToken.create({
    data: {
      userId,
      familyId,
      tokenHash: hashRefreshToken(token),
      expiresAt,
      userAgent: truncate(client.userAgent, 255),
      ipAddress: truncate(client.ipAddress, 45),
    },
  });
  return { token, expiresAt };
}

async function revokeFamily(familyId: string): Promise<void> {
  await prisma.refreshToken.updateMany({
    where: { familyId, revokedAt: null },
    data: { revokedAt: new Date() },
  });
}

/**
 * Exchanges a refresh token for a new one (rotation).
 * A token that was already rotated or revoked is treated as stolen: every token in its
 * family is revoked, which logs out both the attacker and the legitimate session.
 */
export async function rotateRefreshToken(
  token: string,
  client: ClientInfo,
): Promise<{ user: User; refreshToken: IssuedRefreshToken }> {
  const invalid = AppError.unauthenticated('Session expired, please sign in again');
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(token) },
    include: { user: true },
  });
  if (!stored) throw invalid;

  if (stored.revokedAt) {
    logger.warn(
      { userId: stored.userId, familyId: stored.familyId },
      'Refresh token reuse detected; revoking session family',
    );
    await revokeFamily(stored.familyId);
    throw invalid;
  }
  if (stored.expiresAt <= new Date()) throw invalid;

  const refreshToken = await prisma.$transaction(async (tx) => {
    // Conditional update: of two concurrent rotations of the same token, exactly one wins.
    const { count } = await tx.refreshToken.updateMany({
      where: { id: stored.id, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    if (count === 0) throw invalid;
    return issueRefreshToken(stored.userId, client, stored.familyId, tx);
  });

  return { user: stored.user, refreshToken };
}

/** Ends the session the token belongs to. Unknown tokens are ignored: logout always succeeds. */
export async function revokeRefreshToken(token: string): Promise<void> {
  const stored = await prisma.refreshToken.findUnique({
    where: { tokenHash: hashRefreshToken(token) },
    select: { familyId: true },
  });
  if (stored) await revokeFamily(stored.familyId);
}

/** Housekeeping: drops a user's tokens that can no longer be used. */
export async function deleteExpiredRefreshTokens(userId: string): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { userId, expiresAt: { lte: new Date() } },
  });
}
