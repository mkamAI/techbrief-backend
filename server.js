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

// Generate brief
app.post("/api/generate", async (req, res) => {
  const deviceId = req.headers["x-device-id"];
  const { topic } = req.body;

  if (!deviceId) {
    return res.status(400).json({ error: "Missing x-device-id header" });
  }
  if (!topic || typeof topic !== "string" || !topic.trim()) {
    return res.status(400).json({ error: "topic is required" });
  }

  // ── Rate limit check ────────────────────────────────────────────────────────
  const usage = getUsage(deviceId);
  const isPro = req.headers["x-is-pro"] === "true"; // extend with real subscription check

  if (!isPro && usage.count >= FREE_DAILY_LIMIT) {
    return res.status(429).json({
      error: "free_limit_reached",
      message: `You've used all ${FREE_DAILY_LIMIT} free briefs for today. Upgrade to Pro for unlimited access.`,
      used: usage.count,
      limit: FREE_DAILY_LIMIT,
    });
  }

  // ── Call Claude Haiku ────────────────────────────────────────────────────────
  try {
    const message = await anthropic.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 2000,
      messages: [{ role: "user", content: makePrompt(topic.trim()) }],
    });

    const text = message.content[0]?.type === "text" ? message.content[0].text : "";
    const cleaned = text
      .trim()
      .replace(/^```json\s*/m, "")
      .replace(/\s*```$/m, "")
      .trim();

    // Validate JSON before sending
    const brief = JSON.parse(cleaned);

    // Increment usage AFTER successful generation
    const newUsage = incrementUsage(deviceId);

    res.json({
      brief,
      usage: {
        used: newUsage.count,
        limit: FREE_DAILY_LIMIT,
        remaining: Math.max(0, FREE_DAILY_LIMIT - newUsage.count),
      },
    });
  } catch (err) {
    console.error("[/api/generate]", err.message);
    if (err instanceof SyntaxError) {
      return res.status(500).json({ error: "Failed to parse Claude response. Try again." });
    }
    res.status(500).json({ error: err.message || "Internal server error" });
  }
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
