// tasks/aiMarketRecap.js
import OpenAI from "openai";
import dotenv from "dotenv";
import { Client, GatewayIntentBits } from "discord.js";
import { isMarketOpen } from "../utils/marketHours.js";

dotenv.config();

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ],
});

/**
 * 🧠 AI Market Recap — Macro Option Flow Overview
 * Dynamically adjusts its lookback window (45 min intraday, 60 min near close).
 */
export async function getTopTickersFromDiscord() {
  if (!isMarketOpen()) {
    console.log("⏸️ Market closed — skipping AI Market Recap.");
    return;
  }

  await client.login(process.env.DISCORD_TOKEN);

  // ✅ Pull data from FLOW-LOG (unified call/put log)
  const flowLog = await client.channels.fetch(process.env.FLOW_LOG_CHANNEL_ID);
  const messages = await flowLog.messages.fetch({ limit: 100 });
  const allMessages = [...messages.values()];

  // 🕒 Determine ET hour and dynamic lookback window
  const now = new Date();
  const estNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const estHour = estNow.getHours() + estNow.getMinutes() / 60;

  const lookbackMinutes = estHour >= 15.5 ? 60 : 45; // after 3:30 PM ET widen window
  const cutoff = Date.now() - lookbackMinutes * 60 * 1000;
  const recentMessages = allMessages.filter(m => m.createdTimestamp >= cutoff);

  const calls = [];
  const puts = [];

  // 🧹 Parse each “Saved trade” line
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

  console.log(
    `🧩 MarketRecap (${lookbackMinutes}m window) found ${calls.length} CALLs and ${puts.length} PUTs in ${recentMessages.size} messages`
  );

  // 🔢 Aggregations
  const callCount = calls.length;
  const putCount = puts.length;
  const callTotal = calls.reduce((a, b) => a + b, 0);
  const putTotal = puts.reduce((a, b) => a + b, 0);
  const ratio = putCount ? (callCount / putCount).toFixed(2) : callCount;

  // 🧠 AI Prompt — refined for macro tone
  const prompt = `
You are an AI market analyst writing a high-level macro recap for an options trading community.
Use a professional, confident tone with subtle trader edge.

---
**Data Overview**
- Detection Window: Past ${lookbackMinutes} minutes
- CALL trades: ${callCount} totaling ~$${callTotal.toLocaleString()}
- PUT trades: ${putCount} totaling ~$${putTotal.toLocaleString()}
- Approx. Ratio: ${ratio}:1 (CALL:PUT)

Raw flow excerpts:
${recentMessages.map(m => m.content).filter(Boolean).join("\n")}

---
**Your tasks**
1. Identify the 5 most active tickers and the 5 most impacted sectors based on aggregated volume or frequency.
2. Explain what this flow suggests about *broader market sentiment* — risk-on, defensive, rotation, hedging, etc.
3. Note any concentration in expiry dates or strike clusters that could hint at near-term catalysts.
4. Provide relevant background or public headlines that might explain unusual activity in the leading names (limit to recent 10 days).
5. End with a brief, forward-looking summary (1–3 sessions) in trader terms.

Keep response under ${estHour >= 15.5 ? "500" : "300"} words, structured with clean headers, emojis, and concise bullet points for Discord readability.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.65,
  });

  await client.destroy();

  // 🪄 Header — dynamically reflects lookback window
  const header = [
    "🧠 **AI Market Recap — Macro Option Flow Overview**",
    `⏱️ **Past ${lookbackMinutes} Minutes** | 📊 CALLs: ${callCount} ($${callTotal.toLocaleString()}) | PUTs: ${putCount} ($${putTotal.toLocaleString()}) | Ratio ${ratio}:1`,
    "🪞 A data-driven snapshot of where premium and conviction are flowing across the market.",
    "",
  ].join("\n");

  return header + completion.choices[0].message.content.trim();
}

export default { getTopTickersFromDiscord };
export async function getMarketRecapSummary() {
  return await getTopTickersFromDiscord();
}
