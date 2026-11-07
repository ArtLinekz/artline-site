import { createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";

const port = Number(process.env.PORT || 10000);
const maxBodyBytes = 1024 * 1024;
const sessions = new Map();
const seenMessageIds = new Map();
const sessionTtlMs = 24 * 60 * 60 * 1000;
const replyLimit = 950;

const instructions = [
  "You are the Instagram customer-service assistant for ArtLine_kz, an interior design, turnkey renovation, and custom furniture business.",
  "Reply in the customer's language: Kazakh or Russian. Keep replies warm, short, and natural.",
  "Your goal is to identify the requested service, city in Kazakhstan, object type (apartment or house), and project stage. Ask only for missing details, one or two at a time.",
  "The business is based in Almaty and accepts inquiries from across Kazakhstan, but never promise logistics, price, discounts, timelines, warranty, contract terms, or availability unless provided in the conversation.",
  "Never invent project facts, portfolio results, prices, or claims. For estimates, exact deadlines, complaints, or a request for a human, say a manager should confirm and do not pretend one has been notified.",
  "Do not ask for full address, identity documents, payment information, or phone number. Do not repeat sensitive personal data the customer sends.",
  "Return only the message to send on Instagram, without labels or explanations. Keep it under 700 characters."
].join(" ");

function json(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

function verifySignature(rawBody, header) {
  const secret = process.env.META_APP_SECRET;
  if (!secret || !header || !header.startsWith("sha256=")) return false;
  const expected = Buffer.from("sha256=" + createHmac("sha256", secret).update(rawBody).digest("hex"));
  const received = Buffer.from(header);
  return expected.length === received.length && timingSafeEqual(expected, received);
}

function redacted(text) {
  return text
    .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
    .replace(/(?:\+?\d[\d\s().-]{7,}\d)/g, "[phone]");
}

function langIsKazakh(text) {
  return /[әіңғқүұөһ]/i.test(text);
}

function fallbackReply(text, historyLength) {
  if (langIsKazakh(text)) {
    return historyLength
      ? "Рақмет! Қай қаладасыз және объектіңіз пәтер ме, жеке үй ме? Нақты баға мен мерзімді маман анықтайды."
      : "Сәлеметсіз бе! ArtLine-ға жазғаныңызға рақмет 😊 Сізге қай қызмет керек: дизайн-жоба, жөндеу әлде жиһаз? Қай қаладасыз?";
  }
  return historyLength
    ? "Спасибо! Подскажите, пожалуйста, город и тип объекта — квартира или частный дом? Точную стоимость и сроки подтвердит специалист."
    : "Здравствуйте! Спасибо, что написали в ArtLine 😊 Что вас интересует: дизайн-проект, ремонт под ключ или мебель? В каком вы городе?";
}

async function makeReply(history, latestText) {
  if (process.env.AI_ENABLED !== "true") return fallbackReply(latestText, history.length);

  const apiKey = process.env.OPENAI_API_KEY;
  const model = process.env.OPENAI_MODEL;
  if (!apiKey || !model) throw new Error("AI_NOT_CONFIGURED");

  const input = history.slice(-8).map((item) => ({ role: item.role, content: item.content }));
  input.push({ role: "user", content: redacted(latestText) });

  const response = await fetch("https://api.openai.com/v1/responses", {
    method: "POST",
    headers: { "authorization": "Bearer " + apiKey, "content-type": "application/json" },
    body: JSON.stringify({
      model,
      instructions,
      input,
      max_output_tokens: 240,
      store: false
    }),
    signal: AbortSignal.timeout(20000)
  });

  if (!response.ok) {
    const error = new Error("OPENAI_HTTP_" + response.status);
    error.code = response.status;
    throw error;
  }

  const result = await response.json();
  let output = typeof result.output_text === "string" ? result.output_text.trim() : "";
  if (!output && Array.isArray(result.output)) {
    output = result.output.flatMap((item) => Array.isArray(item.content) ? item.content : [])
      .filter((item) => item.type === "output_text" && typeof item.text === "string")
      .map((item) => item.text).join("").trim();
  }
  if (!output) throw new Error("OPENAI_EMPTY_REPLY");
  return output.slice(0, replyLimit);
}

async function sendInstagramMessage(recipientId, text) {
  const igUserId = process.env.META_IG_USER_ID;
  const token = process.env.META_IG_ACCESS_TOKEN;
  const version = process.env.META_GRAPH_API_VERSION;
  if (!igUserId || !token || !version) throw new Error("META_NOT_CONFIGURED");

  const response = await fetch(
    "https://graph.instagram.com/" + encodeURIComponent(version) + "/" + encodeURIComponent(igUserId) + "/messages",
    {
      method: "POST",
      headers: { "authorization": "Bearer " + token, "content-type": "application/json" },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
      signal: AbortSignal.timeout(15000)
    }
  );
  if (!response.ok) {
    const error = new Error("META_SEND_HTTP_" + response.status);
    error.code = response.status;
    throw error;
  }
}

async function processMessage(event) {
  if (!event || event.message?.is_echo || !event.message?.text || !event.sender?.id || !event.message?.mid) return;

  const messageId = event.message.mid;
  const now = Date.now();
  if (seenMessageIds.has(messageId)) return;
  seenMessageIds.set(messageId, now);
  for (const [id, timestamp] of seenMessageIds) if (now - timestamp > sessionTtlMs) seenMessageIds.delete(id);

  const senderId = event.sender.id;
  const old = sessions.get(senderId);
  const history = old && now - old.updatedAt < sessionTtlMs ? old.messages : [];
  const latestText = String(event.message.text).slice(0, 4000);

  let reply;
  try {
    reply = await makeReply(history, latestText);
  } catch (error) {
    console.error("reply_generation_failed", error.code || error.message);
    reply = fallbackReply(latestText, history.length);
  }

  try {
    await sendInstagramMessage(senderId, reply);
    const updatedMessages = history.concat([
      { role: "user", content: redacted(latestText) },
      { role: "assistant", content: reply }
    ]).slice(-8);
    sessions.set(senderId, { messages: updatedMessages, updatedAt: now });
  } catch (error) {
    console.error("instagram_send_failed", error.code || error.message);
  }
}

function processPayload(payload) {
  if (!payload || !Array.isArray(payload.entry)) return;
  for (const entry of payload.entry) {
    for (const event of entry.messaging || []) {
      void processMessage(event);
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url || "/", "http://localhost");

  if (req.method === "GET" && url.pathname === "/health") {
    return json(res, 200, { ok: true });
  }

  if (req.method === "GET" && url.pathname === "/webhook") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    if (mode === "subscribe" && token && token === process.env.META_VERIFY_TOKEN && challenge) {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      return res.end(challenge);
    }
    return json(res, 403, { error: "verification_failed" });
  }

  if (req.method === "POST" && url.pathname === "/webhook") {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        res.writeHead(413);
        res.end();
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      const rawBody = Buffer.concat(chunks);
      if (!verifySignature(rawBody, req.headers["x-hub-signature-256"])) {
        return json(res, 401, { error: "invalid_signature" });
      }
      let payload;
      try {
        payload = JSON.parse(rawBody.toString("utf8"));
      } catch {
        return json(res, 400, { error: "invalid_json" });
      }
      json(res, 200, { ok: true });
      setImmediate(() => processPayload(payload));
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") {
    return json(res, 200, { service: "ArtLine Instagram agent", status: "running" });
  }

  return json(res, 404, { error: "not_found" });
});

server.listen(port, "0.0.0.0", () => console.log("server_started", port));
