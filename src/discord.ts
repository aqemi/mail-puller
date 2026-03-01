import type { EmailMessage } from './imap';

export async function notifyDiscord(webhookUrl: string, accountName: string, msg: EmailMessage): Promise<void> {
  const embed = {
    title: `New email \u2014 ${accountName}`,
    color: 0x5865f2, // Discord blurple
    fields: [
      { name: 'From', value: (msg.from || '(unknown)').slice(0, 256), inline: true },
      { name: 'Date', value: (msg.date || '(unknown)').slice(0, 256), inline: true },
      { name: 'Subject', value: (msg.subject || '(no subject)').slice(0, 256) },
    ],
    footer: { text: 'mail-puller' },
  };

  const res = await fetch(webhookUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    throw new Error(`Discord webhook failed (${res.status}): ${await res.text()}`);
  }
}
