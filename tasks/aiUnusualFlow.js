// tasks/aiUnusualFlow.js
import OpenAI from "openai";
import dotenv from "dotenv";
import { Client } from "discord.js";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new Client({ intents: ["Guilds", "GuildMessages", "MessageContent"] });

/**
 * 🧠 AI analysis based on live Discord flow (past 30 minutes)
 */
export async function detectUnusualFromDiscord() {
  await client.login(process.env.DISCORD_TOKEN);

  const whaleAlerts = await client.channels.fetch(process.env.DEST_CHANNEL_ID);
  const messages = await whaleAlerts.messages.fetch({ limit: 100 });

  // 🕒 filter to last 30 minutes
  const cutoff = Date.now() - 30 * 60 * 1000;
  const recentMessages = messages.filter(m => m.createdTimestamp >= cutoff);

  // 🧹 parse each message
  const calls = [];
  const puts = [];

  for (const msg of recentMessages.values()) {
    const text = msg.content?.toUpperCase() || "";
    if (!text.includes("SAVED TRADE")) continue;

    const typeMatch = text.match(/\b(CALL|PUT)\b/);
    if (!typeMatch) continue;
    const type = typeMatch[1];

    const premMatch = text.match(/PREMIUM\s*\$?([\d,]+)/);
    const premium = premMatch ? Number(premMatch[1].replace(/,/g, "")) : 0;

    if (type === "CALL") calls.push(premium);
    if (type === "PUT") puts.push(premium);
  }

  // 🔢 totals
  const callCount = calls.length;
  const putCount = puts.length;
  const callTotal = calls.reduce((a, b) => a + b, 0);
  const putTotal = puts.reduce((a, b) => a + b, 0);
  const ratio = putCount ? (callCount / putCount).toFixed(2) : callCount;

  console.log(
    `🧩 UnusualFlow parsed ${callCount} CALLs ($${callTotal.toLocaleString()}) and ${putCount} PUTs ($${putTotal.toLocaleString()}) from past 30 min`
  );

  // 🧠 AI prompt
  const prompt = `
You are an AI market analyst specializing in large options flow.

⏱️ **Analyzed Window:** Past 30 minutes of flow
📊 **Call vs Put Summary**
- CALL trades: ${callCount} totaling ~$${callTotal.toLocaleString()}
- PUT trades: ${putCount} totaling ~$${putTotal.toLocaleString()}
- Approx. Ratio: ${ratio}:1 (CALL:PUT)

Here are the raw messages for context:
${recentMessages.map(m => m.content).filter(Boolean).join("\n")}

Analyze this data to:
1. Identify the most active tickers and sectors.
2. Comment on sentiment (bullish, bearish, or mixed) using counts & premiums.
3. Highlight standout trades or clusters.
4. Note any sector concentration.
5. Conclude with near-term expectations.

Keep it 6-8 sentences, formatted for a Discord trader post.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  await client.destroy();

  // 📊 header for Discord
  const header = `🚨 **AI Unusual Flow**\n⏱️ Past 30 Minutes | 📊 CALL vs PUT → ${callCount} vs ${putCount} | $${callTotal.toLocaleString()} vs $${putTotal.toLocaleString()} | Ratio ${ratio}:1\n\n`;
  return header + completion.choices[0].message.content.trim();
}

export default { detectUnusualFromDiscord };
