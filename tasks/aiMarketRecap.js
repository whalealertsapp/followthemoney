// tasks/aiMarketRecap.js
import OpenAI from "openai";
import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

export async function getTopTickersFromDiscord() {
  await client.login(process.env.DISCORD_TOKEN);

  // 🔄 Fetch messages from the FLOW-LOG channel (contains both CALLs and PUTs)
  const flowLog = await client.channels.fetch(process.env.FLOW_LOG_CHANNEL_ID);
  const messages = await flowLog.messages.fetch({ limit: 100 });
  const allMessages = [...messages.values()];

  const calls = [];
  const puts = [];

  // 🕒 last 30 minutes only
  const cutoff = Date.now() - 30 * 60 * 1000;
  const recentMessages = allMessages.filter(m => m.createdTimestamp >= cutoff);

  // 🧹 parse messages
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

  const callCount = calls.length;
  const putCount = puts.length;
  const callTotal = calls.reduce((a, b) => a + b, 0);
  const putTotal = puts.reduce((a, b) => a + b, 0);
  const ratio = putCount ? (callCount / putCount).toFixed(2) : callCount;

  console.log(
    `🧩 MarketRecap parsed ${callCount} CALLs ($${callTotal.toLocaleString()}) and ${putCount} PUTs ($${putTotal.toLocaleString()}) from past 30 min`
  );

  // 🚫 Skip posting if no new trades
  if (callCount === 0 && putCount === 0) {
    console.log("⚠️ No new trades in the past 30 minutes — skipping AI Market Recap post.");
    await client.destroy();
    return;
  }

  // 🧠 AI prompt
  const prompt = `
You are an experienced AI market analyst summarizing large premium option flow for retail traders.

⏱️ **Analyzed Window:** Past 30 minutes of flow
📊 **Call vs Put Summary**
- CALL trades: ${callCount} totaling ~$${callTotal.toLocaleString()}
- PUT trades: ${putCount} totaling ~$${putTotal.toLocaleString()}
- Approx. Ratio: ${ratio}:1 (CALL:PUT)

Here are the latest raw posts:
${recentMessages.map(m => m.content).filter(Boolean).join("\n")}

Analyze this data to:
1. Identify dominant tickers and sectors by volume.
2. Comment on overall sentiment using both trade counts and total premium.
3. Highlight notable trades or repeating tickers.
4. Discuss any short-term or sector-based themes visible in the data.
5. End with what this flow likely means for market direction in the next 1–3 sessions.

Keep your answer concise, professional, and formatted as a Discord recap post.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  await client.destroy();

  const header = `🧠 **AI Market Recap**\n⏱️ Past 30 Minutes | 📊 CALL vs PUT → ${callCount} vs ${putCount} | $${callTotal.toLocaleString()} vs $${putTotal.toLocaleString()} | Ratio ${ratio}:1\n\n`;
  return header + completion.choices[0].message.content.trim();
}

export default { getTopTickersFromDiscord };

export async function getMarketRecapSummary() {
  return await getTopTickersFromDiscord();
}
