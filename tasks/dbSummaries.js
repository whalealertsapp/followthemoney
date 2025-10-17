import sqlite3 from "sqlite3";
import { open } from "sqlite";

/** connect helper */
async function connect() {
  return open({ filename: "./whales.db", driver: sqlite3.Database });
}

/** top 5 tickers by total premium in last 30 min */
export async function getTopDogsFromDB(limit = 5) {
  const db = await connect();
  const rows = await db.all(`
    SELECT ticker, SUM(premium) AS total
    FROM option_trades
    WHERE trade_time >= strftime('%s','now')*1000 - 1800000
    GROUP BY ticker
    ORDER BY total DESC
    LIMIT ${limit};
  `);
  await db.close();

  if (!rows.length) return "No recent trades found.";
  return rows.map(r => `${r.ticker} — $${(r.total/1e6).toFixed(2)}M premium`).join("<br>");
}

/** short-term high-premium trades (unusual flow) */
export async function getUnusualFlowFromDB(limit = 5) {
  const db = await connect();
  const rows = await db.all(`
    SELECT ticker, strike, expiration, premium
    FROM option_trades
    WHERE trade_time >= strftime('%s','now')*1000 - 1800000
      AND premium > 500000        -- large trades
      AND julianday(expiration) - julianday('now') <= 10  -- short term
    ORDER BY premium DESC
    LIMIT ${limit};
  `);
  await db.close();

  if (!rows.length) return "No unusual flow detected.";
  return rows.map(r =>
    `${r.ticker} $${r.strike} exp ${r.expiration} — $${(r.premium/1e6).toFixed(2)}M`
  ).join("<br>");
}

/** simple recap text */
export async function getMarketRecapFromDB() {
  const db = await connect();
  const summary = await db.get(`
    SELECT COUNT(*) AS trades,
           ROUND(SUM(premium)/1e6,2) AS totalM
    FROM option_trades
    WHERE trade_time >= strftime('%s','now')*1000 - 1800000;
  `);
  await db.close();

  if (!summary.trades) return "Quiet half-hour in the market.";
  return `In the last 30 minutes, ${summary.trades} option trades totaled $${summary.totalM} M in premium.`;
}
