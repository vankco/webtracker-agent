function truncateForDiscordField(value: string, maxLen = 1024): string {
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(0, maxLen - 3))}...`;
}

export async function sendDiscordAlert(
  webhookUrl: string,
  url: string,
  summary: string
): Promise<void> {
  const safeUrl = truncateForDiscordField(url, 1024);
  const safeDescription = truncateForDiscordField(summary, 4096); // embed description limit

  const payload = {
    embeds: [
      {
        title: '🔔 Website Change Detected',
        description: safeDescription,
        color: 0xf59e0b, // amber
        fields: [
          { name: 'URL', value: safeUrl, inline: false },
        ],
        footer: { text: 'Website Monitor Agent' },
        timestamp: new Date().toISOString(),
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
