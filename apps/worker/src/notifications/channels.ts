import nodemailer, { type Transporter } from 'nodemailer';
import { emailChannelConfigSchema, type ChannelType } from '@tracelayer/shared';
import type { RenderedMessage } from './message';

/**
 * One adapter per channel type. Adding Slack, Discord, PagerDuty or webhooks means adding an
 * adapter here and a config schema in @tracelayer/shared; rules, alerts and the delivery
 * pipeline do not change.
 */
export interface ChannelAdapter {
  send(config: unknown, message: RenderedMessage): Promise<void>;
}

export type ChannelAdapters = Record<ChannelType, ChannelAdapter>;

export interface SmtpSettings {
  host: string | undefined;
  port: number;
  user: string | undefined;
  password: string | undefined;
  from: string;
}

/**
 * SMTP when a host is configured; otherwise messages are rendered to JSON and returned to the
 * caller (logged by the worker), so local setups work without any mail server.
 */
export function createMailTransport(smtp: SmtpSettings): Transporter {
  if (!smtp.host) return nodemailer.createTransport({ jsonTransport: true });
  return nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.port === 465,
    auth: smtp.user ? { user: smtp.user, pass: smtp.password ?? '' } : undefined,
    // Fail a stuck send instead of holding the worker; BullMQ retries it later.
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 20_000,
  });
}

export function createEmailAdapter(transport: Transporter, from: string): ChannelAdapter {
  return {
    async send(config, message) {
      const { recipients } = emailChannelConfigSchema.parse(config);
      await transport.sendMail({
        from,
        to: recipients,
        subject: message.subject,
        text: message.text,
        html: message.html,
      });
    },
  };
}
