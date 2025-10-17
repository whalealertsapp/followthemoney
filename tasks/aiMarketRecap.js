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

  const whaleAlerts = await client.channels.fetch(process.env.DEST_CHANNEL_ID);
  const messages = await whaleAlerts.messages.fetch({ limit: 100 });

  // 🕒 filter to last 30 minutes
  const cutoff = Date.now() - 30 * 60 * 1000;
  const recentMessages = messages.filter(m => m.createdTimestamp >= cutoff);

  // 🧹 parse messages
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

  const callCount = calls.length;
  const putCount = puts.length;
  const callTotal = calls.reduce((a, b) => a + b, 0);
  const putTotal = puts.reduce((a, b) => a + b, 0);
  const ratio = putCount ? (callCount / putCount).toFixed(2) : callCount;

  console.log(
    `🧩 MarketRecap parsed ${callCount} CALLs ($${callTotal.toLocaleString()}) and ${putCount} PUTs ($${putTotal.toLocaleString()}) from past 30 min`
  );

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

Analyze to:
1. Identify leading tickers & sectors.
2. Explain sentiment using both counts & premium totals.
3. Mention notable trades or repeating tickers.
4. Discuss any sector/hedging themes.
5. Finish with a forward-looking takeaway.

Keep it concise and formatted for Discord.
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
