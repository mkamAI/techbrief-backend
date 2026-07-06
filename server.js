const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const Anthropic = require("@anthropic-ai/sdk");

const app = express();
const PORT = process.env.PORT || 3001;

// ── Security & middleware ─────────────────────────────────────────────────────
app.use(helmet());
app.use(cors());
app.use(express.json());

// ── Topic cache ───────────────────────────────────────────────────────────────
// Caches generated briefs so repeated lookups are instant (no LLM call).
const topicCache = new Map(); // key: normalizedTopic → { brief, cachedAt }
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function getCachedBrief(topic) {
  const key = topic.toLowerCase().trim();
  const entry = topicCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > CACHE_TTL_MS) {
    topicCache.delete(key);
    return null;
  }
  return entry.brief;
}

function cacheBrief(topic, brief) {
  const key = topic.toLowerCase().trim();
  topicCache.set(key, { brief, cachedAt: Date.now() });
}

// ── In-memory usage store ─────────────────────────────────────────────────────
// { deviceId: { count: N, date: "YYYY-MM-DD" } }
// In production, swap this for Redis or a database.
const usageStore = new Map();

const FREE_DAILY_LIMIT = 3;

function getTodayStr() {
  return new Date().toISOString().slice(0, 10); // "2026-05-08"
}

function getUsage(deviceId) {
  const today = getTodayStr();
  const entry = usageStore.get(deviceId);
  if (!entry || entry.date !== today) {
    return { count: 0, date: today };
  }
  return entry;
}

function incrementUsage(deviceId) {
  const usage = getUsage(deviceId);
  usage.count += 1;
  usageStore.set(deviceId, usage);
  return usage;
}

// ── Anthropic client ──────────────────────────────────────────────────────────
const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Prompt ────────────────────────────────────────────────────────────────────
function makePrompt(topic) {
  return `You are a senior software engineer writing a concise tech brief for developers.
Generate a JSON object (no markdown, raw JSON only) for the topic: "${topic}"

The JSON must exactly match this structure:
{
  "topic": "exact topic name",
  "tagline": "one punchy sentence (max 10 words) capturing why this matters",
  "what_is_it": "2-3 sentences, plain English, no jargon",
  "why_it_matters": "2-3 sentences explaining the problem it solves",
  "concepts": [
    {"term": "Term Name", "definition": "one clear sentence"},
    (6-8 concepts total)
  ],
  "use_when": ["short phrase 1", "short phrase 2", "short phrase 3", "short phrase 4"],
  "avoid_when": ["short phrase 1", "short phrase 2", "short phrase 3", "short phrase 4"],
  "code_comment": "one sentence describing what the code example shows",
  "code_lines": ["line1", "line2", ... up to 18 lines of real, runnable code with comments],
  "youtube_links": [
    {"title": "Video Title", "channel": "Channel Name", "duration": "X min", "url": "youtube.com/watch?v=REAL_ID"},
    (3-4 videos, real videos that exist, under 15 min each)
  ],
  "learn_next": [
    {"topic": "Topic Name", "description": "one sentence on why to learn it next"},
    (3 topics)
  ]
}

Return ONLY the raw JSON. No markdown code fences, no explanation.`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", time: new Date().toISOString() });
});

// Usage check — lets the app show "X of 3 free briefs used today"
app.get("/api/usage", (req, res) => {
  const deviceId = req.headers["x-device-id"];
  if (!deviceId) return res.status(400).json({ error: "Missing x-device-id header" });

  const usage = getUsage(deviceId);
  res.json({
    used: usage.count,
    limit: FREE_DAILY_LIMIT,
    remaining: Math.max(0, FREE_DAILY_LIMIT - usage.count),
    isPro: false, // extend this when you add subscriptions
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
  const usage = getUsage(deviceId);
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
  const cached = getCachedBrief(topic.trim());
  if (cached) {
    const newUsage = incrementUsage(deviceId);
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
        max_tokens: 2000,
        messages: [{ role: "user", content: makePrompt(topic.trim()) }],
      });

      for await (const event of stream) {
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          fullText += event.delta.text;
        }
      }

      const cleaned = fullText.trim().replace(/^```json\s*/m, "").replace(/\s*```$/m, "").trim();
      const brief = JSON.parse(cleaned);
      cacheBrief(topic.trim(), brief);
      const newUsage = incrementUsage(deviceId);

      res.write(`data: ${JSON.stringify({ status: "complete", brief, usage: usagePayload(newUsage), cached: false })}\n\n`);
      return res.end();
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
      max_tokens: 2000,
      messages: [{ role: "user", content: makePrompt(topic.trim()) }],
    });

    const text = message.content[0]?.type === "text" ? message.content[0].text : "";
    const cleaned = text.trim().replace(/^```json\s*/m, "").replace(/\s*```$/m, "").trim();
    const brief = JSON.parse(cleaned);
    cacheBrief(topic.trim(), brief);
    const newUsage = incrementUsage(deviceId);

    res.json({ brief, usage: usagePayload(newUsage) });
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
