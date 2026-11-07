# Free Cloudflare Worker for ArtLine Instagram

This Worker receives Instagram webhooks, verifies Meta's HMAC signature, and replies to inbound text messages. It uses Cloudflare Workers AI with `@cf/zai-org/glm-4.7-flash` only when `AI_ENABLED` is set to `true`. AI is disabled by default; with AI disabled it sends fixed Kazakh/Russian intake replies.

## Deploy on Cloudflare Free

Use the Cloudflare Workers **Free** plan only.

- Connect the GitHub repository `ArtLinekz/artline-site`
- Select branch `instagram-agent-server`
- Set the root/build directory to `cloudflare-worker`
- Deploy as a Worker with the included `wrangler.jsonc`
- Leave `AI_ENABLED=false` until the account owner explicitly approves sending customer message text to Cloudflare Workers AI
- Keep the Worker on Workers Free; do not enable Workers Paid or add prepaid credits

Cloudflare's Free Workers plan has a 100,000-request daily limit. Workers AI has 10,000 free Neurons per day. When a Free limit is reached, further requests fail; they do not roll over into a paid plan. The bot may stop generating AI replies until the daily reset.

## Worker secrets

Set these through the Cloudflare dashboard's Worker secrets. Never commit their values:

- `META_APP_SECRET`
- `META_VERIFY_TOKEN`
- `META_IG_ACCESS_TOKEN`
- `META_IG_USER_ID`
- `META_GRAPH_API_VERSION`

Set the non-secret variable `AI_ENABLED=true` only after approval. The model service receives the recent text in a customer's Direct conversation (email and phone-like strings are redacted first). Conversation context is held only in the Worker isolate's memory for up to one hour and is lost when the isolate restarts. Message bodies are not logged.

## Meta webhook

After deployment, use this callback URL in the Meta app:

`https://<worker-name>.<account-subdomain>.workers.dev/webhook`

Use the exact `META_VERIFY_TOKEN` value for verification and subscribe to Instagram message events. Complete Meta's required app review before enabling real customer access.
