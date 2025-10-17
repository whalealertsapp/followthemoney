// tasks/aiUnusualFlow.js
import OpenAI from "openai";
import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

/**
 * 🧠 AI analysis based on live Discord flow (past 60 minutes)
 */
export async function detectUnusualFromDiscord() {
  await client.login(process.env.DISCORD_TOKEN);

  // ✅ Fetch from unified FLOW-LOG channel
  const flowLog = await client.channels.fetch(process.env.FLOW_LOG_CHANNEL_ID);
  const messages = await flowLog.messages.fetch({ limit: 100 });
  const allMessages = [...messages.values()];

  // 🕒 Last 60 minutes
  const cutoff = Date.now() - 60 * 60 * 1000;
  const recentMessages = allMessages.filter(m => m.createdTimestamp >= cutoff);

  const calls = [];
  const puts = [];

  // 🧹 Parse each “Saved trade” post
  for (const msg of recentMessages) {
    const text = msg.content?.toUpperCase() || "";
    if (!text.includes("SAVED TRADE")) continue;

    const typeMatch = text.match(/\b(CALL|PUT)\b/);
    const premMatch = text.match(/PREMIUM\s*\$?([\d,]+)/);

    const type = typeMatch ? typeMatch[1] : null;
    const premium = premMatch ? Number(premMatch[1].replace(/,/g, "")) : 0;

    if (type === "CALL") calls.push(premium);
    else if (type === "PUT") puts.push(premium);
  }

  console.log(`🧩 UnusualFlow found ${calls.length} CALLs and ${puts.length} PUTs in ${recentMessages.size} messages`);

  // 🔢 Totals
  const callCount = calls.length;
  const putCount = puts.length;
  const callTotal = calls.reduce((a, b) => a + b, 0);
  const putTotal = puts.reduce((a, b) => a + b, 0);
  const ratio = putCount ? (callCount / putCount).toFixed(2) : callCount;

  // 🧠 AI Prompt
  const prompt = `
You are an AI market analyst specializing in large options flow.

⏱️ **Analyzed Window:** Past 60 minutes
📊 **Call vs Put Summary**
- CALL trades: ${callCount} totaling ~$${callTotal.toLocaleString()}
- PUT trades: ${putCount} totaling ~$${putTotal.toLocaleString()}
- Approx. Ratio: ${ratio}:1 (CALL:PUT)

Here are the raw posts for context:
${recentMessages.map(m => m.content).filter(Boolean).join("\n")}

Analyze this data to:
1. Identify the most interesting trades that stand out in this timeframe.
2. Comment on any unique buys that are for companies not often seen in our data.
3. Note any sector concentration or hedging activity.
4. Conclude with near-term expectations (1–3 sessions).

Keep it concise, formatted for a Discord trader post.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  await client.destroy();

  const header = `🚨 **AI Unusual Flow**\n⏱️ Past 60 Minutes | 📊 CALL vs PUT → ${callCount} vs ${putCount} | $${callTotal.toLocaleString()} vs $${putTotal.toLocaleString()} | Ratio ${ratio}:1\n\n`;
  return header + completion.choices[0].message.content.trim();
}

export default { detectUnusualFromDiscord };
