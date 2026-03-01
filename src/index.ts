import { ImapClient } from './imap';
import { notifyDiscord } from './discord';
import type { Account } from './config';

async function processAccount(account: Account, env: Env): Promise<void> {
  const kvKey = `lastUID:${account.name}`;
  const stored = await env.MAIL_STATE.get(kvKey);
  const lastUID = stored !== null ? parseInt(stored) : 0;

  const client = new ImapClient();
  try {
    await client.connect(account.host, account.port);
    await client.login(account.user, account.password);

    // UIDNEXT - 1 = highest existing UID (0 when mailbox is empty)
    const currentMaxUID = await client.selectInbox();

    if (lastUID === 0) {
      // First run: set the baseline so we don't flood Discord with old mail
      console.log(`[${account.name}] First run — baseline UID set to ${currentMaxUID}`);
      await env.MAIL_STATE.put(kvKey, String(currentMaxUID));
      return;
    }

    if (currentMaxUID <= lastUID) {
      console.log(`[${account.name}] No new messages`);
      return;
    }

    const newUIDs = await client.searchUidSince(lastUID);
    console.log(`[${account.name}] ${newUIDs.length} new message(s)`);

    if (newUIDs.length === 0) return;

    const messages = await client.fetchMessages(newUIDs);

    for (const msg of messages) {
      await notifyDiscord(env.DISCORD_WEBHOOK, account.name, msg);
    }

    const maxNewUID = Math.max(...newUIDs);
    await env.MAIL_STATE.put(kvKey, String(maxNewUID));
  } finally {
    await client.logout();
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response(
      'mail-puller is running.\n' + 'Test the scheduled handler locally:\n' + '  curl "http://localhost:8787/__scheduled?cron=*+*+*+*+*"',
    );
  },

  async scheduled(_event: ScheduledController, env: Env, _ctx: ExecutionContext): Promise<void> {
    const accounts: Account[] = JSON.parse(env.ACCOUNTS_JSON);
    const results = await Promise.allSettled(accounts.map((account) => processAccount(account, env)));

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r.status === 'rejected') {
        console.error(`[${accounts[i].name}] Error:`, r.reason);
      }
    }
  },
} satisfies ExportedHandler<Env>;
