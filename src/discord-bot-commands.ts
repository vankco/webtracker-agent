/**
 * discord-bot-commands.ts
 * Pure, testable helpers for the Discord bot — no Discord gateway dependency.
 * Covers command definitions, permission checks, and reply formatting.
 */

import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import type { MonitorStatus } from './api-types.js';

export const COMMANDS = {
  help: 'help',
  status: 'status',
  ask: 'ask',
} as const;

export type CommandName = (typeof COMMANDS)[keyof typeof COMMANDS];

export function requiresAdmin(commandName: string): boolean {
  return commandName === COMMANDS.status;
}

export function slashCommandDefinitions(): ReturnType<SlashCommandBuilder['toJSON']>[] {
  return [
    new SlashCommandBuilder()
      .setName(COMMANDS.help)
      .setDescription('Show available commands'),

    new SlashCommandBuilder()
      .setName(COMMANDS.status)
      .setDescription('Monitor health and last check time (admin only)')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),

    new SlashCommandBuilder()
      .setName(COMMANDS.ask)
      .setDescription('Ask anything about product availability, pricing, or trends')
      .addStringOption((opt) =>
        opt
          .setName('question')
          .setDescription('e.g. "what is in stock today?" or "which bag sells out fastest?"')
          .setRequired(true)
      ),
  ].map((cmd) => cmd.toJSON());
}

export function formatHelpReply(): string {
  return [
    '**WebTracker Bot**',
    '',
    '`/ask question:<text>` — Ask anything: stock, prices, trends, release patterns',
    '`/status` — Monitor health and last check time *(admin only)*',
    '`/help` — Show this message',
  ].join('\n');
}

export function formatStatusReply(status: MonitorStatus): string {
  const lines: string[] = [];

  lines.push(status.running ? '🟢 **Monitor is running**' : '🔴 **Monitor is stopped**');

  if (status.targetUrl) {
    lines.push(`Watching: ${status.targetUrl}`);
  }

  if (status.lastCheck) {
    const t = new Date(status.lastCheck).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    lines.push(`Last check: ${t} PT`);
  }

  if (status.nextCheck) {
    const t = new Date(status.nextCheck).toLocaleString('en-US', {
      timeZone: 'America/Los_Angeles',
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    lines.push(`Next check: ${t} PT`);
  }

  if (status.lastResult) {
    lines.push(`Last result: ${status.lastResult.summary}`);
  }

  if (status.errors.length > 0) {
    lines.push(`⚠️ Recent errors: ${status.errors.length}`);
  }

  return lines.join('\n');
}

/** Truncates a reply to fit within Discord's 2000-char message limit. */
export function truncateReply(text: string, limit = 1900): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…*(truncated)*`;
}
