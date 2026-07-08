const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const Anthropic = require("@anthropic-ai/sdk");
const { Redis } = require("@upstash/redis");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security & middleware ─────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// ── Upstash Redis ─────────────────────────────────────────────────────────────
// Falls back to in-memory if env vars are not set (local dev).
let redis = null;
if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log("✅ Upstash Redis connected");
} else {
  console.warn("⚠️  Upstash env vars missing — using in-memory fallback");
}

// ── Topic cache ───────────────────────────────────────────────────────────────
// Redis key: brief:<normalizedTopic>  TTL: 24 hours
// Falls back to an in-process Map when Redis is unavailable.
const memCache = new Map();
const CACHE_TTL_SECONDS = 24 * 60 * 60; // 24 hours

function cacheKey(topic) {
  return `brief:${topic.toLowerCase().trim()}`;
}

// Wrap any Redis call with a 2s timeout — falls back to null on timeout/error
async function redisWithTimeout(fn) {
  if (!redis) return null;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("Redis timeout")), 2000)),
    ]);
  } catch (err) {
    console.warn("⚠️  Redis skipped:", err.message);
    return null;
  }
}

async function getCachedBrief(topic) {
  const data = await redisWithTimeout(() => redis.get(cacheKey(topic)));
  if (data) return data;
  return memCache.get(cacheKey(topic)) || null;
}

async function cacheBrief(topic, brief) {
  memCache.set(cacheKey(topic), brief); // always update in-memory
  redisWithTimeout(() => redis.set(cacheKey(topic), brief, { ex: CACHE_TTL_SECONDS })).catch(() => {});
}

// ── Usage store ───────────────────────────────────────────────────────────────
// Redis key: usage:<deviceId>:<YYYY-MM-DD>  TTL: 25 hours (survives day rollover)
// Falls back to in-process Map.
const usageMemStore = new Map();
const FREE_DAILY_LIMIT = 3;

function getTodayStr() {
  return new Date().toISOString().slice(0, 10);
}

async function getUsage(deviceId) {
  const today = getTodayStr();
  const count = await redisWithTimeout(() => redis.get(`usage:${deviceId}:${today}`));
  if (count !== null) return { count: Number(count), date: today };
  const entry = usageMemStore.get(deviceId);
  if (!entry || entry.date !== today) return { count: 0, date: today };
  return entry;
}

async function incrementUsage(deviceId) {
  const today = getTodayStr();
  const key = `usage:${deviceId}:${today}`;
  const redisCount = await redisWithTimeout(async () => {
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 25 * 60 * 60);
    return count;
  });
  if (redisCount !== null) return { count: redisCount, date: today };
  // fallback to in-memory
  const usage = await getUsage(deviceId);
  usage.count += 1;
  usageMemStore.set(deviceId, usage);
  return usage;
}

// ── Hot-topic pre-seed ────────────────────────────────────────────────────────
// On startup, generate briefs for popular topics if not already cached.
// Runs in the background — does NOT block server startup.
const HOT_TOPICS = [
  "React", "TypeScript", "GraphQL", "Docker", "Kubernetes",
  "REST API", "WebSockets", "JWT", "OAuth", "SQL vs NoSQL",
  "Machine Learning", "Large Language Models", "Vector Databases",
  "CI/CD", "Microservices", "Serverless", "Redis", "PostgreSQL",
  "Swift", "SwiftUI",
];

// Seed a single topic in the background (fire-and-forget, called after first real request)
async function seedTopicInBackground(topic) {
  if (!redis) return;
  try {
    const existing = await getCachedBrief(topic);
    if (existing) return;
    const anthropicClient = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const message = await anthropicClient.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: makePrompt(topic) }],
    });
    const text = message.content[0]?.type === "text" ? message.content[0].text : "";
    await cacheBrief(topic, extractJSON(text));
    console.log(`🌱 Cached: ${topic}`);
  } catch (err) {
    console.warn(`⚠️  Seed failed for "${topic}":`, err.message);
  }
}

// Called after each generate request completes — seeds the next uncached hot topic.
// This piggybacks on real traffic so it works on serverless (no background processes needed).
let seedIndex = 0;
function seedNextHotTopic() {
  if (!redis) return;
  const topic = HOT_TOPICS[seedIndex % HOT_TOPICS.length];
  seedIndex++;
  seedTopicInBackground(topic).catch(() => {});
}

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Prompt ────────────────────────────────────────────────────────────────────
function makePrompt(topic) {
  return `You are a senior software engineer. Generate a concise tech brief as raw JSON (no markdown) for: "${topic}"

Exact structure required:
{
  "topic": "exact topic name",
  "tagline": "one punchy sentence, max 8 words",
  "what_is_it": "1-2 sentences, plain English",
  "why_it_matters": "1-2 sentences, the core problem it solves",
  "concepts": [
    {"term": "Term", "definition": "one sentence"},
    (exactly 4 concepts)
  ],
  "use_when": ["phrase 1", "phrase 2", "phrase 3"],
  "avoid_when": ["phrase 1", "phrase 2", "phrase 3"],
  "code_comment": "one sentence describing the example",
  "code_lines": ["line1", "line2", ... 6-8 lines of real runnable code],
  "youtube_links": [
    {"title": "Video Title", "channel": "Channel Name", "duration": "X min", "url": "youtube.com/watch?v=REAL_ID"}
  ],
  "learn_next": [
    {"topic": "Topic", "description": "one sentence on why"},
    (exactly 3 topics)
  ]
}

Return ONLY raw JSON. No markdown, no explanation.`;
}

// ── JSON extraction ───────────────────────────────────────────────────────────
// Finds the first complete {...} object in the text — handles markdown fences,
// preamble text, and any trailing content Claude might add.
function extractJSON(text) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) throw new SyntaxError("No JSON object found");
  return JSON.parse(text.slice(start, end + 1));
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Usage check — lets the app show "X of 3 free briefs used today"
app.get("/api/usage", async (req, res) => {
  const deviceId = req.headers["x-device-id"];
  if (!deviceId) return res.status(400).json({ error: "Missing x-device-id header" });

  const usage = await getUsage(deviceId);
  res.json({
    used: usage.count,
    limit: FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - usage.count),
    isPro: false,
    resetsAt: getTodayStr() + "T00:00:00Z",
  });
});

// Generate brief — supports SSE streaming (Accept: text/event-stream) and plain JSON.
// SSE events:
//   data: {"status":"generating"}              → server is alive, LLM call in progress
//   data: {"status":"complete","brief":{...},"usage":{...},"cached":bool}
//   data: {"status":"error","message":"..."}
app.post("/api/generate", async (req, res) => {
  const deviceId = req.headers["x-device-id"];
  const { topic } = req.body;
  const wantsStream = (req.headers["accept"] || "").includes("text/event-stream");

  if (!deviceId) {
    return res.status(400).json({ error: "Missing x-device-id header" });
  }
  if (!topic || typeof topic !== "string" || !topic.trim()) {
    return res.status(400).json({ error: "topic is required" });
  }

  // ── Rate limit check ────────────────────────────────────────────────────────
  const usage = await getUsage(deviceId);
  const isPro = req.headers["x-is-pro"] === "true";

  if (!isPro && usage.count >= FREE_DAILY_LIMIT) {
    return res.status(429).json({
      error: "free_limit_reached",
      message: `You've used all ${FREE_DAILY_LIMIT} free briefs for today. Upgrade to Pro for unlimited access.`,
      used: usage.count,
      limit: FREE_DAILY_LIMIT,
    });
  }

  // ── Helper: build usage payload ─────────────────────────────────────────────
  function usagePayload(u) {
    return { used: u.count, limit: FREE_DAILY_LIMIT, remaining: Math.max(0, FREE_DAILY_LIMIT - u.count) };
  }

  // ── Cache hit — instant response ─────────────────────────────────────────────
  const cached = await getCachedBrief(topic.trim());
  if (cached) {
    const newUsage = await incrementUsage(deviceId);
    if (wantsStream) {
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.write(`data: ${JSON.stringify({ status: "complete", brief: cached, usage: usagePayload(newUsage), cached: true })}\n\n`);
      return res.end();
    }
    return res.json({ brief: cached, usage: usagePayload(newUsage), cached: true });
  }

  // ── SSE streaming path ───────────────────────────────────────────────────────
  if (wantsStream) {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");

    // Immediately signal the server is alive — eliminates perceived cold-start delay
    res.write(`data: ${JSON.stringify({ status: "generating" })}\n\n`);

    try {
      let fullText = "";
      const stream = anthropic.messages.stream({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 1000,
        messages: [{ role: "user", content: makePrompt(topic.trim()) }],
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          fullText += event.delta.text;
        }
      }

      const brief = extractJSON(fullText);
      await cacheBrief(topic.trim(), brief);
      const newUsage = await incrementUsage(deviceId);

      res.write(`data: ${JSON.stringify({ status: "complete", brief, usage: usagePayload(newUsage), cached: false })}\n\n`);
      res.end();
      seedNextHotTopic(); // warm the next hot topic after responding
      return;
    } catch (err) {
      console.error("[/api/generate SSE]", err.message);
      res.write(`data: ${JSON.stringify({ status: "error", message: err instanceof SyntaxError ? "Failed to parse response. Try again." : (err.message || "Internal server error") })}\n\n`);
      return res.end();
    }
  }

  // ── Non-streaming path (backward compat) ────────────────────────────────────
  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1000,
      messages: [{ role: "user", content: makePrompt(topic.trim()) }],
    });

    const text = message.content[0]?.type === "text" ? message.content[0].text : "";
    const brief = extractJSON(text);
    await cacheBrief(topic.trim(), brief);
    const newUsage = await incrementUsage(deviceId);

    res.json({ brief, usage: usagePayload(newUsage) });
    seedNextHotTopic();
  } catch (err) {
    console.error("[/api/generate]", err.message);
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: "Failed to parse Claude response. Try again." });
    }
    res.status(500).json({ error: err.message || "Internal server error" });
  }
});

// ── Privacy Policy ────────────────────────────────────────────────────────────
app.get("/privacy", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Privacy Policy — TechBrief</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 680px; margin: 60px auto; padding: 0 24px; color: #1e293b; line-height: 1.7; }
    h1 { font-size: 28px; font-weight: 700; color: #1e40af; margin-bottom: 4px; }
    h2 { font-size: 17px; font-weight: 600; color: #1e293b; margin-top: 32px; margin-bottom: 8px; }
    p, li { font-size: 15px; color: #475569; }
    .meta { font-size: 13px; color: #94a3b8; margin-bottom: 40px; }
    a { color: #1e40af; }
  </style>
</head>
<body>
  <h1>Privacy Policy</h1>
  <p class="meta">TechBrief &mdash; Last updated: May 2026</p>

  <p>TechBrief (&ldquo;we&rdquo;, &ldquo;our&rdquo;, &ldquo;the app&rdquo;) is committed to protecting your privacy.</p>

  <h2>Data We Collect</h2>
  <p>We do not collect any personally identifiable information. The app assigns a random anonymous device identifier (stored only on your device) solely to enforce the free daily usage limit. This identifier is never linked to your name, email, or any personal data.</p>

  <h2>Data We Do Not Collect</h2>
  <p>We do not collect your name, email address, location, contacts, photos, health data, or any other personal information.</p>

  <h2>Third Parties</h2>
  <p>Brief generation is powered by Anthropic (Claude AI). Your search query is sent to our backend server and then to Anthropic&rsquo;s API. No personal information is transmitted. Anthropic&rsquo;s privacy policy is available at <a href="https://www.anthropic.com/privacy">anthropic.com/privacy</a>.</p>

  <h2>Data Retention</h2>
  <p>Usage counters reset daily. We do not retain your search history or generated briefs on our servers.</p>

  <h2>Children&rsquo;s Privacy</h2>
  <p>TechBrief does not knowingly collect data from children under 13. The app is rated 4+ and contains no user-generated content or social features.</p>

  <h2>Changes to This Policy</h2>
  <p>We may update this policy from time to time. The &ldquo;Last updated&rdquo; date at the top will reflect any changes.</p>

  <h2>Contact</h2>
  <p>Questions about this policy? Email: <a href="mailto:maruti.kampli@gmail.com">maruti.kampli@gmail.com</a></p>
</body>
</html>`);
});

// ── Support Page ──────────────────────────────────────────────────────────────
app.get("/support", (req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
  <title>Support — TechBrief</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 680px; margin: 60px auto; padding: 0 24px; color: #1e293b; line-height: 1.7; }
    h1 { font-size: 28px; font-weight: 700; color: #1e40af; margin-bottom: 4px; }
    h2 { font-size: 17px; font-weight: 600; color: #1e293b; margin-top: 32px; margin-bottom: 8px; }
    p, li { font-size: 15px; color: #475569; }
    .meta { font-size: 13px; color: #94a3b8; margin-bottom: 40px; }
    .card { background: #eff6ff; border-radius: 12px; padding: 20px 24px; margin-top: 32px; }
    a { color: #1e40af; }
    ul { padding-left: 20px; }
    li { margin-bottom: 8px; }
  </style>
</head>
<body>
  <h1>TechBrief Support</h1>
  <p class="meta">We&rsquo;re here to help.</p>

  <h2>Frequently Asked Questions</h2>

  <h2>How many free briefs do I get?</h2>
  <p>You get 3 free briefs every day. The counter resets at midnight UTC. No account required.</p>

  <h2>What is TechBrief Pro?</h2>
  <p>TechBrief Pro ($4.99/month) gives you unlimited briefs, a saved library, PDF export, and priority generation speed. You can upgrade from within the app.</p>

  <h2>A brief generated incorrect information. What should I do?</h2>
  <p>TechBrief uses Claude AI (Anthropic) to generate briefs. While it is highly capable, AI can occasionally make mistakes. Always cross-reference critical information with official documentation. If you encounter a persistent issue with a specific topic, please let us know.</p>

  <h2>The app is not generating a brief. What's wrong?</h2>
  <ul>
    <li>Check your internet connection.</li>
    <li>Make sure you have remaining free briefs for today (or upgrade to Pro).</li>
    <li>Try a slightly different or more specific topic name.</li>
    <li>If the problem persists, contact us below.</li>
  </ul>

  <h2>How do I cancel my Pro subscription?</h2>
  <p>Subscriptions are managed through Apple. Go to <strong>Settings &rarr; your name &rarr; Subscriptions</strong> on your iPhone to cancel at any time.</p>

  <div class="card">
    <strong>Still need help?</strong><br/>
    Email us at <a href="mailto:maruti.kampli@gmail.com">maruti.kampli@gmail.com</a> and we&rsquo;ll get back to you within 48 hours.
  </div>
</body>
</html>`);
});

// ── Start (local dev) / Export (Vercel serverless) ───────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`✅ TechBrief backend running on port ${PORT}`);
    console.log(`   Free limit: ${FREE_DAILY_LIMIT} briefs/day per device`);
    console.log(`   Model: claude-haiku-4-5-20251001`);
  });
}

module.exports = app;
