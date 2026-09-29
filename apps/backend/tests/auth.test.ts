import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app';
import { REFRESH_COOKIE } from '../src/controllers/auth.controller';
import { prisma } from '../src/lib/prisma';
import { cookiePair, getSetCookie, resetDatabase } from './helpers';

const VALID_USER = {
  name: 'Ada Lovelace',
  email: 'ada@example.com',
  password: 'correct-horse-battery',
  confirmPassword: 'correct-horse-battery',
};

// A fresh app per test gives every test its own in-memory rate-limit counters.
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await resetDatabase();
  app = createApp();
});

afterAll(async () => {
  await prisma.$disconnect();
});

async function registerUser(overrides: Partial<typeof VALID_USER> = {}) {
  const res = await request(app)
    .post('/api/auth/register')
    .send({ ...VALID_USER, ...overrides });
  expect(res.status).toBe(201);
  return {
    accessToken: res.body.data.accessToken as string,
    refreshCookie: cookiePair(getSetCookie(res, REFRESH_COOKIE)),
    userId: res.body.data.user.id as string,
  };
}

describe('POST /api/auth/register', () => {
  it('creates the user, returns a session and sets a hardened refresh cookie', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_USER, name: '  Ada Lovelace ', email: '  Ada@Example.COM ' });

    expect(res.status).toBe(201);
    expect(res.body.data.user).toEqual({
      id: expect.any(String),
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      createdAt: expect.any(String),
    });
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    expect(res.body.data.expiresIn).toBe(900);
    expect(JSON.stringify(res.body)).not.toContain('password');

    const cookie = getSetCookie(res, REFRESH_COOKIE);
    expect(cookie).toMatch(/HttpOnly/i);
    expect(cookie).toMatch(/SameSite=Strict/i);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(cookie).toMatch(/Expires=/);
  });

  it('stores a bcrypt hash, never the plaintext password', async () => {
    await registerUser();
    const user = await prisma.user.findUniqueOrThrow({ where: { email: VALID_USER.email } });
    expect(user.passwordHash).toMatch(/^\$2[aby]\$/);
    expect(user.passwordHash).not.toContain(VALID_USER.password);
  });

  it('stores only a hash of the refresh token', async () => {
    const { refreshCookie } = await registerUser();
    const rawToken = refreshCookie.split('=')[1];
    const [stored] = await prisma.refreshToken.findMany();
    expect(stored?.tokenHash).toHaveLength(64);
    expect(stored?.tokenHash).not.toBe(rawToken);
  });

  it('rejects invalid input with field-level details', async () => {
    const res = await request(app).post('/api/auth/register').send({
      name: '',
      email: 'not-an-email',
      password: 'short',
      confirmPassword: 'different',
    });

    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const paths = (res.body.error.details as { path: string }[]).map((d) => d.path);
    expect(paths).toEqual(expect.arrayContaining(['name', 'email', 'password', 'confirmPassword']));
    expect(await prisma.user.count()).toBe(0);
  });

  it('rejects passwords longer than bcrypt can hash', async () => {
    const long = 'a'.repeat(73);
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_USER, password: long, confirmPassword: long });
    expect(res.status).toBe(400);
  });

  it('returns CONFLICT for an email that is already registered, ignoring case', async () => {
    await registerUser();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...VALID_USER, email: 'ADA@example.com' });

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(res.body.error.details).toEqual([{ path: 'email', message: expect.any(String) }]);
  });
});

describe('POST /api/auth/login', () => {
  beforeEach(async () => {
    await registerUser();
  });

  it('returns a session for valid credentials', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ADA@example.com', password: VALID_USER.password });

    expect(res.status).toBe(200);
    expect(res.body.data.user.email).toBe(VALID_USER.email);
    expect(getSetCookie(res, REFRESH_COOKIE)).toBeDefined();
  });

  it('gives the same answer for a wrong password and an unknown email', async () => {
    const wrongPassword = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID_USER.email, password: 'wrong-password' });
    const unknownEmail = await request(app)
      .post('/api/auth/login')
      .send({ email: 'nobody@example.com', password: 'wrong-password' });

    for (const res of [wrongPassword, unknownEmail]) {
      expect(res.status).toBe(401);
      expect(res.body.error).toMatchObject({
        code: 'UNAUTHENTICATED',
        message: 'Invalid email or password',
      });
      expect(getSetCookie(res, REFRESH_COOKIE)).toBeUndefined();
    }
  });

  it('rate-limits repeated failed attempts', async () => {
    const attempt = () =>
      request(app)
        .post('/api/auth/login')
        .send({ email: VALID_USER.email, password: 'wrong-password' });

    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(401);

    const blocked = await attempt();
    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['ratelimit-policy']).toBeDefined();
  });

  it('does not count successful logins towards the limit', async () => {
    for (let i = 0; i < 12; i++) {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: VALID_USER.email, password: VALID_USER.password });
      expect(res.status).toBe(200);
    }
  });
});

describe('GET /api/auth/me', () => {
  it('returns the current user for a valid access token', async () => {
    const { accessToken, userId } = await registerUser();
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ id: userId, email: VALID_USER.email });
  });

  it('requires a bearer token', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it.each([
    ['garbage', 'not-a-jwt'],
    [
      'wrong secret',
      jwt.sign({}, 'x'.repeat(40), {
        subject: 'u',
        issuer: 'tracelayer',
        audience: 'tracelayer-api',
      }),
    ],
    [
      'alg none',
      `${Buffer.from('{"alg":"none","typ":"JWT"}').toString('base64url')}.${Buffer.from('{"sub":"u","iss":"tracelayer","aud":"tracelayer-api"}').toString('base64url')}.`,
    ],
  ])('rejects an invalid token (%s)', async (_label, token) => {
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Invalid access token');
  });

  it('rejects an expired token', async () => {
    const { userId } = await registerUser();
    const expired = jwt.sign({}, process.env.JWT_SECRET as string, {
      subject: userId,
      issuer: 'tracelayer',
      audience: 'tracelayer-api',
      expiresIn: -10,
    });
    const res = await request(app).get('/api/auth/me').set('Authorization', `Bearer ${expired}`);
    expect(res.status).toBe(401);
    expect(res.body.error.message).toBe('Access token expired');
  });

  it('rejects a valid token once the account is deleted', async () => {
    const { accessToken, userId } = await registerUser();
    await prisma.user.delete({ where: { id: userId } });
    const res = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${accessToken}`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/refresh', () => {
  it('rotates the refresh token and issues a new access token', async () => {
    const { refreshCookie } = await registerUser();
    const res = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);

    expect(res.status).toBe(200);
    expect(res.body.data.accessToken).toEqual(expect.any(String));
    const rotated = cookiePair(getSetCookie(res, REFRESH_COOKIE));
    expect(rotated).not.toBe(refreshCookie);

    const me = await request(app)
      .get('/api/auth/me')
      .set('Authorization', `Bearer ${res.body.data.accessToken}`);
    expect(me.status).toBe(200);
  });

  it('treats reuse of a rotated token as theft and revokes the whole session', async () => {
    const { refreshCookie: original } = await registerUser();
    const first = await request(app).post('/api/auth/refresh').set('Cookie', original);
    const rotated = cookiePair(getSetCookie(first, REFRESH_COOKIE));

    const replay = await request(app).post('/api/auth/refresh').set('Cookie', original);
    expect(replay.status).toBe(401);

    // The legitimate holder's newer token is now revoked too.
    const afterTheft = await request(app).post('/api/auth/refresh').set('Cookie', rotated);
    expect(afterTheft.status).toBe(401);
    expect(await prisma.refreshToken.count({ where: { revokedAt: null } })).toBe(0);
  });

  it('keeps other sessions of the same user alive when one is revoked', async () => {
    const { refreshCookie: laptop } = await registerUser();
    const phoneLogin = await request(app)
      .post('/api/auth/login')
      .send({ email: VALID_USER.email, password: VALID_USER.password });
    const phone = cookiePair(getSetCookie(phoneLogin, REFRESH_COOKIE));

    await request(app).post('/api/auth/logout').set('Cookie', laptop);

    expect((await request(app).post('/api/auth/refresh').set('Cookie', phone)).status).toBe(200);
  });

  it('rejects an expired refresh token and clears the cookie', async () => {
    const { refreshCookie } = await registerUser();
    await prisma.refreshToken.updateMany({ data: { expiresAt: new Date(Date.now() - 1000) } });

    const res = await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie);
    expect(res.status).toBe(401);
    expect(getSetCookie(res, REFRESH_COOKIE)).toMatch(/Expires=Thu, 01 Jan 1970/);
  });

  it('rejects a request with no refresh cookie', async () => {
    const res = await request(app).post('/api/auth/refresh');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHENTICATED');
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(app)
      .post('/api/auth/refresh')
      .set('Cookie', `${REFRESH_COOKIE}=forged-token-value`);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/auth/logout', () => {
  it('revokes the session and clears the cookie', async () => {
    const { refreshCookie } = await registerUser();
    const res = await request(app).post('/api/auth/logout').set('Cookie', refreshCookie);

    expect(res.status).toBe(204);
    expect(getSetCookie(res, REFRESH_COOKIE)).toMatch(/Expires=Thu, 01 Jan 1970/);
    expect((await request(app).post('/api/auth/refresh').set('Cookie', refreshCookie)).status).toBe(
      401,
    );
  });

  it('succeeds even without a session', async () => {
    const res = await request(app).post('/api/auth/logout');
    expect(res.status).toBe(204);
  });
});
