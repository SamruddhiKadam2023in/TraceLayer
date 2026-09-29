import type { Request, Response } from 'express';
import {
  createAlertRuleSchema,
  createChannelSchema,
  firedAlertsQuerySchema,
  listAlertRulesQuerySchema,
  updateAlertRuleSchema,
  updateChannelSchema,
  type ApiSuccessBody,
} from '@tracelayer/shared';
import { z } from 'zod';
import { getAuthUserId } from '../middleware/auth';
import {
  authorizeAlertRule,
  authorizeChannel,
  authorizeMonitor,
  authorizeProject,
  authorizeWorkspace,
  parseId,
} from '../services/access.service';
import * as ruleService from '../services/alert-rule.service';
import * as channelService from '../services/channel.service';

function send<T>(res: Response, data: T, status = 200): void {
  const body: ApiSuccessBody<T> = { success: true, data };
  res.status(status).json(body);
}

const ruleAccess = (req: Request, permission: 'workspace.read' | 'monitoring.manage') =>
  authorizeAlertRule(getAuthUserId(req), parseId(req.params.ruleId, 'Alert rule'), permission);

const channelAccess = (req: Request, permission: 'workspace.read' | 'members.manage') =>
  authorizeChannel(getAuthUserId(req), parseId(req.params.channelId, 'Channel'), permission);

// ─── Alert rules (spec §37: /api/alerts) ─────────────────────────────────────

export async function listRules(req: Request, res: Response): Promise<void> {
  const { projectId, monitorId } = listAlertRulesQuerySchema.parse(req.query);
  const userId = getAuthUserId(req);
  const access = monitorId
    ? await authorizeMonitor(userId, monitorId, 'workspace.read')
    : await authorizeProject(userId, projectId!, 'workspace.read');
  send(res, await ruleService.listRules(access, monitorId));
}

export async function createRule(req: Request, res: Response): Promise<void> {
  const config = createAlertRuleSchema.parse(req.body);
  // Alert thresholds are monitoring configuration: owners, admins and members.
  const access = await authorizeMonitor(getAuthUserId(req), config.monitorId, 'monitoring.manage');
  send(res, await ruleService.createRule(access, config), 201);
}

export async function getRule(req: Request, res: Response): Promise<void> {
  send(res, await ruleService.getRule(await ruleAccess(req, 'workspace.read')));
}

export async function updateRule(req: Request, res: Response): Promise<void> {
  const changes = updateAlertRuleSchema.parse(req.body);
  send(res, await ruleService.updateRule(await ruleAccess(req, 'monitoring.manage'), changes));
}

export async function deleteRule(req: Request, res: Response): Promise<void> {
  await ruleService.deleteRule(await ruleAccess(req, 'monitoring.manage'));
  res.status(204).end();
}

export async function listFired(req: Request, res: Response): Promise<void> {
  const { projectId, ...query } = firedAlertsQuerySchema.parse(req.query);
  const access = await authorizeProject(getAuthUserId(req), projectId, 'workspace.read');
  send(res, await ruleService.listFiredAlerts(access, query));
}

// ─── Notification channels ───────────────────────────────────────────────────

export async function listChannels(req: Request, res: Response): Promise<void> {
  const { workspaceId } = z.object({ workspaceId: z.uuid() }).parse(req.query);
  const access = await authorizeWorkspace(getAuthUserId(req), workspaceId, 'workspace.read');
  send(res, await channelService.listChannels(access));
}

export async function createChannel(req: Request, res: Response): Promise<void> {
  const { workspaceId, ...input } = createChannelSchema.parse(req.body);
  // Where alerts are sent is workspace configuration: owners and admins.
  const access = await authorizeWorkspace(getAuthUserId(req), workspaceId, 'members.manage');
  send(res, await channelService.createChannel(access, input), 201);
}

export async function updateChannel(req: Request, res: Response): Promise<void> {
  const changes = updateChannelSchema.parse(req.body);
  send(
    res,
    await channelService.updateChannel(await channelAccess(req, 'members.manage'), changes),
  );
}

export async function deleteChannel(req: Request, res: Response): Promise<void> {
  await channelService.deleteChannel(await channelAccess(req, 'members.manage'));
  res.status(204).end();
}

export async function testChannel(req: Request, res: Response): Promise<void> {
  send(
    res,
    await channelService.sendTestNotification(await channelAccess(req, 'members.manage')),
    202,
  );
}
