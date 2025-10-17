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

  // ✅ Fetch from FLOW-LOG (unified call/put log)
  const flowLog = await client.channels.fetch(process.env.FLOW_LOG_CHANNEL_ID);
  const messages = await flowLog.messages.fetch({ limit: 100 });
  const allMessages = [...messages.values()];

  // 🕒 last 60 minutes
  const cutoff = Date.now() - 60 * 60 * 1000;
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

  console.log(`🧩 MarketRecap found ${calls.length} CALLs and ${puts.length} PUTs in ${recentMessages.size} recent messages`);

  const callCount = calls.length;
  const putCount = puts.length;
  const callTotal = calls.reduce((a, b) => a + b, 0);
  const putTotal = puts.reduce((a, b) => a + b, 0);
  const ratio = putCount ? (callCount / putCount).toFixed(2) : callCount;

  // 🧠 Prompt
  const prompt = `
You are an experienced AI market analyst summarizing large premium option flow.

⏱️ **Analyzed Window:** Past 60 minutes
📊 **Call vs Put Summary**
- CALL trades: ${callCount} totaling ~$${callTotal.toLocaleString()}
- PUT trades: ${putCount} totaling ~$${putTotal.toLocaleString()}
- Approx. Ratio: ${ratio}:1 (CALL:PUT)

Here are the latest raw posts:
${recentMessages.map(m => m.content).filter(Boolean).join("\n")}

Analyze this data to:
1. Identify the 5 leading tickers & 5 leading sectors based on total volume in last 60 minutes.
2. Give detail on the background of companies receiving this volume and any recent news/developments publicly disclosed or rumored in the last 10 days.
3. Highlight standout trades.
4. Discuss hedging or sector themes.
5. Give a forward-looking takeaway.

Format for Discord.
`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages: [{ role: "user", content: prompt }],
    temperature: 0.7,
  });

  await client.destroy();

  const header = `🧠 **AI Market Recap**\n⏱️ Past 60 Minutes | 📊 CALL vs PUT → ${callCount} vs ${putCount} | $${callTotal.toLocaleString()} vs $${putTotal.toLocaleString()} | Ratio ${ratio}:1\n\n`;
  return header + completion.choices[0].message.content.trim();
}

export default { getTopTickersFromDiscord };
export async function getMarketRecapSummary() {
  return await getTopTickersFromDiscord();
}
