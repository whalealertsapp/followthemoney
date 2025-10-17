// tasks/emailDigest.js
import fs from "fs";
import sqlite3 from "sqlite3";
import { open } from "sqlite";

// === Connect helper ===
async function connect() {
  return open({ filename: "./whales.db", driver: sqlite3.Database });
}

// === Fetch Top Call / Put Options ===
async function getTopOptions({ isPut = false, limit = 7 } = {}) {
  const db = await connect();
  const optionType = isPut ? "put" : "call";

  const trades = await db.all(`
    SELECT ticker, strike, expiration, premium, type
    FROM option_trades
    WHERE LOWER(type) = '${optionType}'
      AND trade_time >= strftime('%s','now') * 1000 - 1800000  -- last 30 min
    ORDER BY premium DESC
    LIMIT ${limit};
  `);

  await db.close();
  return trades;
}

// === Generate a recap of total trades & volume ===
async function getMarketRecapFromDB() {
  const db = await connect();
  const result = await db.get(`
    SELECT COUNT(*) AS trades, ROUND(SUM(premium)/1e6,2) AS totalM
    FROM option_trades
    WHERE trade_time >= strftime('%s','now') * 1000 - 1800000;
  `);
  await db.close();

  if (!result.trades) return "No trading activity detected in the last 30 minutes.";
  return `In the past 30 minutes, ${result.trades} option trades totaled <b>$${result.totalM}M</b> in premium volume.`;
}

// === Top Dogs (tickers with highest total premium) ===
async function getTopDogsFromDB(limit = 5) {
  const db = await connect();
  const rows = await db.all(`
    SELECT ticker, SUM(premium) AS total
    FROM option_trades
    WHERE trade_time >= strftime('%s','now') * 1000 - 1800000
    GROUP BY ticker
    ORDER BY total DESC
    LIMIT ${limit};
  `);
  await db.close();

  if (!rows.length) return "No dominant tickers this session.";
  return rows.map(r => `${r.ticker} — $${(r.total / 1e6).toFixed(2)}M total premium`).join("<br>");
}

// === Unusual Flow (short-dated, high premium) ===
async function getUnusualFlowFromDB(limit = 5) {
  const db = await connect();
  const rows = await db.all(`
    SELECT ticker, strike, expiration, premium
    FROM option_trades
    WHERE trade_time >= strftime('%s','now') * 1000 - 1800000
      AND premium >= 500000
      AND julianday(expiration) - julianday('now') <= 10
    ORDER BY premium DESC
    LIMIT ${limit};
  `);
  await db.close();

  if (!rows.length) return "No unusual short-term flow detected.";
  return rows.map(r => 
    `${r.ticker} $${r.strike} exp ${r.expiration} — $${(r.premium / 1e6).toFixed(2)}M`
  ).join("<br>");
}

/**
 * Generates a combined Beehiiv email digest using ONLY local DB data:
 *  - Top call options
 *  - Top put options
 *  - Market Recap
 *  - Top Dogs
 *  - Unusual Flow
 */
export async function generateEmailDigest() {
  try {
    console.log("📊 Generating Beehiiv email digest...");

    // Pull all live data concurrently from whales.db
    const [topCalls, topPuts, recapRaw, topDogsRaw, unusualRaw] = await Promise.all([
      getTopOptions({ isPut: false, limit: 7 }),
      getTopOptions({ isPut: true, limit: 7 }),
      getMarketRecapFromDB(),
      getTopDogsFromDB(),
      getUnusualFlowFromDB(),
    ]);

    // Format sections
    const callsSection = formatOptionsSection(topCalls, "🔥 Top Call Options (Last 30 Minutes)", "#e8f5e9");
    const putsSection = formatOptionsSection(topPuts, "🛑 Top Put Options (Last 30 Minutes)", "#ffebee");
    const recap = formatSection(recapRaw, "Market Recap");
    const topDogs = formatSection(topDogsRaw, "Top Dogs");
    const unusual = formatSection(unusualRaw, "Unusual Flow");

    // === Final HTML body ===
    const html = `
    <div style="font-family:Inter,Arial,sans-serif;line-height:1.6;color:#111;background:#fff;padding:20px;">
      <h1 style="text-align:center;">🐋 FOLLOW THE MONEY — Daily Flow Digest</h1>

      ${callsSection}
      ${putsSection}
      ${recap}
      ${topDogs}
      ${unusual}

      <hr style="margin-top:25px;border:none;border-top:1px solid #eee;">
      <p style="font-size:13px;color:#666;text-align:center;">
        Sent automatically by <b>Whale Alerts AI</b> • Free Tier Digest<br>
        Upgrade for real-time alerts → 
        <a href="https://whop.com/whalealerts" target="_blank">Join Pro Flow</a>
      </p>
    </div>
    `;

    fs.writeFileSync("./emailDigest.html", html);
    console.log("✅ Email digest generated successfully → emailDigest.html");
    return html;
  } catch (err) {
    console.error("❌ Failed to generate email digest:", err);
    return "<p>Error generating email digest.</p>";
  }
}

/**
 * Formats a section of text into a styled HTML card
 */
function formatSection(data, title) {
  if (!data) return `<div><h3>${title}</h3><p>No data available.</p></div>`;

  return `
    <div style="background:#f9fafb;padding:12px 16px;border-radius:8px;margin-bottom:10px;">
      <h3 style="margin:0 0 5px 0;">${title}</h3>
      <div>${data}</div>
    </div>`;
}

/**
 * Formats Call/Put tables with subtle color coding
 */
function formatOptionsSection(trades, title, bgColor = "#f9fafb") {
  if (!trades?.length) {
    return `
      <div style="background:${bgColor};padding:12px 16px;border-radius:8px;margin-bottom:10px;">
        <h3 style="margin:0 0 5px 0;">${title}</h3>
        <p>No significant trades detected in the last 30 minutes.</p>
      </div>`;
  }

  const rows = trades
    .map(t => {
      const prem = t.premium >= 1_000_000
        ? `$${(t.premium / 1_000_000).toFixed(2)}M`
        : `$${(t.premium / 1_000).toFixed(0)}K`;
      return `
        <tr>
          <td style="padding:6px 10px;">${t.ticker}</td>
          <td style="padding:6px 10px;">$${t.strike}</td>
          <td style="padding:6px 10px;">${t.expiration}</td>
          <td style="padding:6px 10px;">${prem}</td>
        </tr>`;
    })
    .join("");

  return `
    <div style="background:${bgColor};padding:12px 16px;border-radius:8px;margin-bottom:10px;">
      <h3 style="margin:0 0 5px 0;">${title}</h3>
      <table style="width:100%;border-collapse:collapse;font-size:14px;">
        <thead>
          <tr style="background:#efefef;">
            <th align="left" style="padding:6px 10px;">Ticker</th>
            <th align="left" style="padding:6px 10px;">Strike</th>
            <th align="left" style="padding:6px 10px;">Expiration</th>
            <th align="left" style="padding:6px 10px;">Premium</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}
