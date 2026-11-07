# ArtLine Instagram reply service

This is a Node.js webhook service for the Instagram professional account. It only processes inbound text messages, ignores echoes, verifies Meta webhook signatures, and sends replies through the Instagram Messaging API.

## Deployment on Render

Create a **Web Service** from this repository and branch:

- Repository: \`ArtLinekz/artline-site\`
- Branch: \`instagram-agent-server\`
- Root directory: \`instagram-agent\`
- Build command: leave empty
- Start command: \`npm start\`
- Health check path: \`/health\`

Use a paid always-on Render instance for production. Render's free services spin down after inactivity and are not intended for production.

## Environment variables

Set these in Render's Environment settings. Never commit their values:

- \`META_APP_SECRET\` — App Secret from the Meta app.
- \`META_VERIFY_TOKEN\` — a new random string you create for webhook verification.
- \`META_IG_ACCESS_TOKEN\` — Instagram access token from Meta.
- \`META_IG_USER_ID\` — Instagram professional account ID.
- \`META_GRAPH_API_VERSION\` — Graph API version shown in current Meta documentation.
- \`AI_ENABLED\` — defaults to disabled. Set to \`true\` only after enabling the AI reply provider.
- \`OPENAI_API_KEY\` — optional secret; required only when AI is enabled.
- \`OPENAI_MODEL\` — model name required only when AI is enabled.

When AI is disabled, the service sends a short fixed intake response. When enabled, it sends the customer's recent message context to the OpenAI Responses API. The service redacts email addresses and phone-like strings before the AI call, keeps a short conversation window in server memory for up to 24 hours, and does not log message bodies. Memory clears when the service restarts.

## Meta setup

After deployment, configure the public HTTPS webhook URL as:

\`https://<render-service>.onrender.com/webhook\`

Set the verify token to the exact value from \`META_VERIFY_TOKEN\`, then subscribe the app to Instagram messaging events. Do not enable or publish the app until Meta's required review and verification steps are complete.
