import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import { createSecretBox } from '@tracelayer/executor';
import { env } from '../config/env';
import { DEMO_EMAIL_DOMAIN, DEMO_WORKSPACE_NAME } from '../demo/demo-data';
import { seedDemoWorkspace } from '../demo/seed';
import { closeMonitorQueue } from '../lib/monitor-queue';
import { prisma } from '../lib/prisma';
import { unscheduleMonitors } from '../services/monitor-cleanup.service';

/**
 * Seeds the demo workspace (spec §52).
 *
 *   pnpm seed:demo                          # creates a demo account (password printed once)
 *   pnpm seed:demo --owner you@example.com  # adds the demo workspace to your own account
 *
 * In Docker: docker compose exec backend node apps/backend/dist/scripts/seed-demo.js [--owner …]
 *
 * Running it again replaces the demo workspace, so its history always ends now.
 */

const DEMO_OWNER_EMAIL = `demo@${DEMO_EMAIL_DOMAIN}`;

function ownerEmailFromArgs(): string | null {
  const args = process.argv.slice(2);
  const i = args.indexOf('--owner');
  if (i === -1) return null;
  const email = args[i + 1]?.trim().toLowerCase();
  if (!email) throw new Error('Usage: seed-demo [--owner <email of an existing account>]');
  return email;
}

async function main(): Promise<void> {
  const ownerEmail = ownerEmailFromArgs();
  let login: { email: string; password: string } | null = null;
  let ownerId: string;

  if (ownerEmail) {
    const owner = await prisma.user.findUnique({ where: { email: ownerEmail } });
    if (!owner) throw new Error(`No account with the email ${ownerEmail}. Register it first.`);
    ownerId = owner.id;
  } else {
    // A fresh random password on every run: never a known, shared demo password.
    const password = randomBytes(12).toString('base64url');
    const passwordHash = await bcrypt.hash(password, env.BCRYPT_ROUNDS);
    const owner = await prisma.user.upsert({
      where: { email: DEMO_OWNER_EMAIL },
      update: { passwordHash },
      create: { name: 'Demo Owner', email: DEMO_OWNER_EMAIL, passwordHash },
    });
    // The new password ends every earlier session of the demo account.
    await prisma.refreshToken.deleteMany({ where: { userId: owner.id } });
    ownerId = owner.id;
    login = { email: DEMO_OWNER_EMAIL, password };
  }

  const started = Date.now();
  const summary = await seedDemoWorkspace(prisma, createSecretBox(env.ENCRYPTION_KEY), {
    ownerId,
    onRemovedMonitors: unscheduleMonitors,
  });

  const lines = [
    `Seeded "${DEMO_WORKSPACE_NAME}" in ${((Date.now() - started) / 1000).toFixed(1)} s:`,
    `  ${summary.projects} projects, ${summary.endpoints} endpoints, ${summary.monitors} monitors (paused)`,
    `  ${summary.runs} monitor runs over 7 days, ${summary.incidents} incidents (${summary.activeIncidents} active)`,
    '',
    login
      ? `Sign in as ${login.email} with the password: ${login.password}\n(It changes every time this script runs.)`
      : `Sign in as ${ownerEmail} and switch to "${DEMO_WORKSPACE_NAME}".`,
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

main()
  .catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await Promise.allSettled([prisma.$disconnect(), closeMonitorQueue()]);
  });
