const MODEL_ID = "@cf/zai-org/glm-4.7-flash";
const MAX_REPLY_CHARS = 900;
const SESSION_TTL_MS = 60 * 60 * 1000;
const sessions = new Map();
const seenIds = new Map();

const SYSTEM_PROMPT = [
  "You are the Instagram customer-service assistant for ArtLine_kz, an interior design, turnkey renovation, and custom furniture business in Kazakhstan.",
  "Reply in the customer's language, Kazakh or Russian. Keep the tone friendly and concise.",
  "Your goal is to understand which service the person needs, their city, whether the object is an apartment or house, and the project stage. Ask only for missing details, one or two at a time.",
  "The business is based in Almaty and accepts inquiries from across Kazakhstan. Do not promise service logistics outside Almaty until the team confirms feasibility.",
  "Never invent prices, discounts, availability, timelines, warranty, contract terms, portfolio facts, or client results. For exact estimates, deadlines, complaints, or requests for a human, say a specialist needs to confirm. Never claim a specialist has been notified.",
  "Do not ask for a full address, identity documents, payment details, or phone number. Do not repeat private contact details sent by a customer.",
  "Return only the message to send on Instagram. Keep it under 700 characters."
].join(" ");

function replyJson(body, status = 200, type = "application/json; charset=utf-8") {
  return new Response(body, { status, headers: { "content-type": type, "cache-control": "no-store" } });
}

function constantTimeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function validSignature(rawBody, header, secret) {
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const digest = await crypto.subtle.sign("HMAC", key, rawBody);
  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
  return constantTimeEqual(header, "sha256=" + hex);
}

function redact(text) {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone]");
}

function isKazakh(text) {
  return /[әіңғқүұөһ]/i.test(text);
}

function fallbackReply(text, historyLength) {
  if (isKazakh(text)) {
    return historyLength
      ? "Рақмет! Қай қаладасыз және нысан пәтер ме, жеке үй ме? Нақты баға мен мерзімді маман анықтайды."
      : "Сәлеметсіз бе! ArtLine-ға жазғаныңызға рақмет 😊 Сізге қай қызмет керек: дизайн-жоба, жөндеу әлде жиһаз? Қай қаладасыз?";
  }
  return historyLength
    ? "Спасибо! Подскажите, пожалуйста, город и тип объекта — квартира или частный дом? Точную цену и сроки подтвердит специалист."
    : "Здравствуйте! Спасибо, что написали в ArtLine 😊 Что вас интересует: дизайн-проект, ремонт или мебель? В каком вы городе?";
}

function readModelText(result) {
  if (typeof result === "string") return result.trim();
  if (typeof result?.response === "string") return result.response.trim();
  const choice = result?.choices?.[0]?.message?.content;
  if (typeof choice === "string") return choice.trim();
  return "";
}

async function makeReply(history, latestText, env) {
  if (env.AI_ENABLED !== "true") return fallbackReply(latestText, history.length);
  const messages = [{ role: "system", content: SYSTEM_PROMPT }]
    .concat(history.slice(-6))
    .concat([{ role: "user", content: redact(latestText) }]);

  const result = await env.AI.run(MODEL_ID, {
    messages,
    max_completion_tokens: 200,
    temperature: 0.3,
    store: false
  });
  const text = readModelText(result);
  if (!text) throw new Error("AI_EMPTY_REPLY");
  return text.slice(0, MAX_REPLY_CHARS);
}

async function sendInstagramMessage(recipientId, text, env) {
  const igUserId = env.META_IG_USER_ID;
  const token = env.META_IG_ACCESS_TOKEN;
  const version = env.META_GRAPH_API_VERSION;
  if (!igUserId || !token || !version) throw new Error("META_NOT_CONFIGURED");

  const response = await fetch(
    "https://graph.instagram.com/" + encodeURIComponent(version) + "/" + encodeURIComponent(igUserId) + "/messages",
    {
      method: "POST",
      headers: { authorization: "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } })
    }
  );
  if (!response.ok) throw new Error("META_SEND_HTTP_" + response.status);
}

async function handleMessage(event, env) {
  if (!event?.sender?.id || !event?.message?.text || event.message.is_echo) return;
  const senderId = String(event.sender.id);
  const messageId = event.message.mid ? String(event.message.mid) : "";
  const now = Date.now();

  if (messageId && seenIds.has(messageId)) return;
  if (messageId) seenIds.set(messageId, now);
  for (const [id, timestamp] of seenIds) if (now - timestamp > SESSION_TTL_MS) seenIds.delete(id);

  const current = sessions.get(senderId);
  const history = current && now - current.updatedAt < SESSION_TTL_MS ? current.messages : [];
  const latestText = String(event.message.text).slice(0, 4000);
  let reply;

  try {
    reply = await makeReply(history, latestText, env);
  } catch (error) {
    console.error("ai_reply_failed", error?.message || "unknown");
    reply = fallbackReply(latestText, history.length);
  }

  try {
    await sendInstagramMessage(senderId, reply, env);
    sessions.set(senderId, {
      messages: history.concat([
        { role: "user", content: redact(latestText) },
        { role: "assistant", content: reply }
      ]).slice(-6),
      updatedAt: now
    });
  } catch (error) {
    console.error("instagram_send_failed", error?.message || "unknown");
  }
}

async function processPayload(payload, env) {
  if (!Array.isArray(payload?.entry)) return;
  const tasks = [];
  for (const entry of payload.entry) {
    for (const event of entry.messaging || []) tasks.push(handleMessage(event, env));
  }
  await Promise.allSettled(tasks);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return replyJson(JSON.stringify({ ok: true }));
    }

    if (request.method === "GET" && url.pathname === "/webhook") {
      const mode = url.searchParams.get("hub.mode");
      const token = url.searchParams.get("hub.verify_token");
      const challenge = url.searchParams.get("hub.challenge");
      if (mode === "subscribe" && token && token === env.META_VERIFY_TOKEN && challenge) {
        return replyJson(challenge, 200, "text/plain; charset=utf-8");
      }
      return replyJson(JSON.stringify({ error: "verification_failed" }), 403);
    }

    if (request.method === "POST" && url.pathname === "/webhook") {
      const rawBody = await request.arrayBuffer();
      if (rawBody.byteLength > 1024 * 1024) return replyJson(JSON.stringify({ error: "payload_too_large" }), 413);
      const valid = await validSignature(rawBody, request.headers.get("x-hub-signature-256"), env.META_APP_SECRET);
      if (!valid) return replyJson(JSON.stringify({ error: "invalid_signature" }), 401);

      let payload;
      try {
        payload = JSON.parse(new TextDecoder().decode(rawBody));
      } catch {
        return replyJson(JSON.stringify({ error: "invalid_json" }), 400);
      }

      ctx.waitUntil(processPayload(payload, env));
      return replyJson(JSON.stringify({ ok: true }));
    }

    return replyJson(JSON.stringify({ error: "not_found" }), 404);
  }
};
