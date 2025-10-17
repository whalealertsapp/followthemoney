// tasks/flowTally.js
import dotenv from "dotenv";
import { Client } from "discord.js";
dotenv.config();

const client = new Client({ intents: ["Guilds", "GuildMessages", "MessageContent"] });

// ✅ Proper named export
export async function postFlowTally() {
  await client.login(process.env.DISCORD_TOKEN);

  try {
    // ✅ Use FLOW-LOG channel for both reading and posting
    const flowLog = await client.channels.fetch(process.env.FLOW_LOG_CHANNEL_ID);
    const messages = await flowLog.messages.fetch({ limit: 100 });

    // 🕒 Last 30 minutes
    const cutoff = Date.now() - 30 * 60 * 1000;
    const recentMessages = messages.filter(m => m.createdTimestamp >= cutoff);

    const calls = [];
    const puts = [];

    for (const msg of recentMessages.values()) {
      const text = msg.content?.toUpperCase() || "";
      if (!text.includes("SAVED TRADE")) continue;

      const typeMatch = text.match(/\b(CALL|PUT)\b/);
      const premMatch = text.match(/PREMIUM\s*\$?([\d,]+)/);
      const premium = premMatch ? Number(premMatch[1].replace(/,/g, "")) : 0;

      if (typeMatch?.[1] === "CALL") calls.push(premium);
      else if (typeMatch?.[1] === "PUT") puts.push(premium);
    }

    const callCount = calls.length;
    const putCount = puts.length;
    const callTotal = calls.reduce((a, b) => a + b, 0);
    const putTotal = puts.reduce((a, b) => a + b, 0);
    const ratio = putCount ? (callCount / putCount).toFixed(2) : callCount;
    const sentiment =
      callTotal > putTotal
        ? "🟢 **Bullish bias**"
        : callTotal < putTotal
        ? "🔴 **Bearish bias**"
        : "⚪ **Neutral flow**";

    // 🚫 Skip posting if no new trades
    if (callCount === 0 && putCount === 0) {
      console.log("⚠️ No new trades in the past 30 minutes — skipping Flow Tally post.");
      await client.destroy();
      return;
    }

    const summary = `
📊 **Flow Tally (Past 30 Min)**
CALLS: ${callCount} ($${callTotal.toLocaleString()})
PUTS: ${putCount} ($${putTotal.toLocaleString()})
Ratio: ${ratio}:1 (CALL:PUT)
${sentiment}
    `.trim();

    // ✅ Post tally summary to #flow-log
    await flowLog.send(summary);
    console.log("✅ Posted Flow Tally to #flow-log");
  } catch (err) {
    console.error("❌ Error posting flow tally:", err);
  } finally {
    await client.destroy();
  }
}
