/**
 * discord-bot.ts
 * Standalone Discord bot process — mirrors the health-monitor.ts structure.
 * Connects via the Discord Gateway and exposes slash commands that query
 * the agent's REST API (no direct imports of app internals).
 *
 * Start with:  npm run bot   (also launched by `npm start` if token is configured)
 *
 * Required config (config.json or env vars):
 *   discordBotToken      / DISCORD_BOT_TOKEN
 *   discordBotClientId   / DISCORD_BOT_CLIENT_ID
 *   discordBotGuildId    / DISCORD_BOT_GUILD_ID
 */

import {
  Client,
  GatewayIntentBits,
  REST,
  Routes,
  PermissionFlagsBits,
  type ChatInputCommandInteraction,
} from 'discord.js';
import { mergeConfig, readJsonConfig } from './config.js';
import { parseCliArgs } from './cli-args.js';
import {
  requiresAdmin,
  slashCommandDefinitions,
  formatHelpReply,
  formatStatusReply,
  truncateReply,
  COMMANDS,
} from './discord-bot-commands.js';
import type { MonitorStatus } from './api-types.js';

// Bot credentials/IDs live in config.json (token is a secret — never a flag);
// client/guild IDs may also be passed as CLI flags. apiPort selects the API port.
const merged = mergeConfig(readJsonConfig(), parseCliArgs().config);
const PORT = merged.apiPort ?? 3001;
const BASE = `http://localhost:${PORT}/api`;
const TOKEN = merged.discordBotToken ?? '';
const CLIENT_ID = merged.discordBotClientId ?? '';
const GUILD_ID = merged.discordBotGuildId ?? '';

async function handleHelp(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.reply({ content: formatHelpReply() });
}

async function handleStatus(interaction: ChatInputCommandInteraction): Promise<void> {
  await interaction.deferReply({ ephemeral: true });
  const res = await fetch(`${BASE}/monitor/status`, { signal: AbortSignal.timeout(8_000) });
  const body = (await res.json()) as { data: MonitorStatus };
  await interaction.editReply({ content: truncateReply(formatStatusReply(body.data)) });
}

async function handleAsk(interaction: ChatInputCommandInteraction): Promise<void> {
  const question = interaction.options.getString('question', true);
  await interaction.deferReply();
  try {
    const res = await fetch(`${BASE}/ask`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      const err = (await res.json()) as { error?: { message?: string } };
      await interaction.editReply({ content: `❌ ${err.error?.message ?? 'Request failed.'}` });
      return;
    }
    const { data } = (await res.json()) as { data: { answer: string } };
    await interaction.editReply({ content: truncateReply(data.answer) });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    await interaction.editReply({ content: `❌ Failed to get answer: ${message}` });
  }
}

async function main(): Promise<void> {
  if (!TOKEN) {
    console.warn('[discord-bot] No DISCORD_BOT_TOKEN configured — exiting.');
    return;
  }
  if (!CLIENT_ID || !GUILD_ID) {
    console.warn('[discord-bot] DISCORD_BOT_CLIENT_ID and DISCORD_BOT_GUILD_ID are required — exiting.');
    return;
  }

  const rest = new REST().setToken(TOKEN);
  await rest.put(Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID), {
    body: slashCommandDefinitions(),
  });
  console.log('[discord-bot] Slash commands registered.');

  const client = new Client({ intents: [GatewayIntentBits.Guilds] });

  client.once('ready', (c) => {
    console.log(`[discord-bot] Logged in as ${c.user.tag}`);
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    const { commandName } = interaction;

    if (requiresAdmin(commandName)) {
      const isAdmin =
        interaction.memberPermissions?.has(PermissionFlagsBits.Administrator) ||
        interaction.guild?.ownerId === interaction.user.id;
      if (!isAdmin) {
        await interaction.reply({
          content: '❌ This command requires Administrator permission.',
          ephemeral: true,
        });
        return;
      }
    }

    try {
      if (commandName === COMMANDS.help) await handleHelp(interaction);
      else if (commandName === COMMANDS.status) await handleStatus(interaction);
      else if (commandName === COMMANDS.ask) await handleAsk(interaction);
    } catch (err) {
      console.error(`[discord-bot] Error handling /${commandName}:`, err);
      const msg = '❌ Something went wrong. Please try again.';
      if (interaction.deferred || interaction.replied) {
        await interaction.editReply({ content: msg }).catch(() => {});
      } else {
        await interaction.reply({ content: msg, ephemeral: true }).catch(() => {});
      }
    }
  });

  await client.login(TOKEN);
}

void main();
