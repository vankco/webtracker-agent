import { formatPacific } from './utils.js';

function truncateForDiscordField(value: string, maxLen = 1024): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

function cleanDisplayUrl(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.origin + parsed.pathname;
  } catch {
    return url.split('#')[0] ?? url;
  }
}

/** Strip hash fragments from any URLs embedded in a text string. */
function cleanUrlsInText(text: string): string {
  return text.replace(/https?:\/\/[^\s]+/g, (match) => cleanDisplayUrl(match));
}

export async function sendDiscordAlert(
  webhookUrl: string,
  url: string,
  summary: string,
  title = '🔔 Website Change Detected',
  linkLabel = 'Available Bags',
  username?: string,
  avatarUrl?: string
): Promise<void> {
  const safeDescription = truncateForDiscordField(cleanUrlsInText(summary), 4096);
  const urlField = url
    ? truncateForDiscordField(`[${linkLabel}](${url})`, 1024)
    : '';

  const fields = urlField ? [{ name: '​', value: urlField, inline: false }] : [];

  const payload: Record<string, unknown> = {
    ...(username ? { username } : {}),
    ...(avatarUrl ? { avatar_url: avatarUrl } : {}),
    embeds: [
      {
        title,
        description: safeDescription,
        color: 0xf59e0b, // amber
        fields,
        footer: { text: `Website Monitor Agent • ${formatPacific()}` },
      },
    ],
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    const detail = body ? ` | ${body.slice(0, 300)}` : '';
    throw new Error(`Discord webhook failed: ${res.status} ${res.statusText}${detail}`);
  }
}
