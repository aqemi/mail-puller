// Augments the generated Env interface with bindings defined in wrangler.jsonc.
// Run `npm run cf-typegen` after creating the KV namespace to regenerate this automatically.
interface Env {
  MAIL_STATE: KVNamespace;
  DISCORD_WEBHOOK: string;
  ACCOUNTS_JSON: string;
}
