import type { Request, Response } from 'express';
import type { ApiSuccessBody, HealthReport } from '@tracelayer/shared';
import { getHealthReport } from '../services/health.service';

/** Liveness: the process is up and serving HTTP. Used by container orchestration. */
export function live(_req: Request, res: Response): void {
  res.json({ success: true, data: { status: 'ok' } });
}

/** Readiness + dependency status. Returns 503 when the database or Redis is down. */
export async function health(_req: Request, res: Response): Promise<void> {
  const report = await getHealthReport();
  const { database, redis } = report.dependencies;
  const serving = database.status === 'up' && redis.status === 'up';
  const body: ApiSuccessBody<HealthReport> = { success: true, data: report };
  res.status(serving ? 200 : 503).json(body);
}
