// ===== /utils/flowUtils.js (Async-ready final version) =====
const sqlite3 = require('sqlite3').verbose();
const DB_PATH = './whales.db';

function queryDb(sql, params = []) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(DB_PATH);
    db.all(sql, params, (err, rows) => {
      db.close();
      if (err) return reject(err);
      resolve(rows || []);
    });
  });
}

/**
 * Get recent call trades since a given timestamp (ms)
 */
async function getRecentTrades(sinceTimestamp) {
  const sql = `
    SELECT ticker, premium, strike, expiration, spot, type, trade_time
    FROM option_trades
    WHERE type = 'call'
      AND CAST(trade_time AS INTEGER) >= ?
    ORDER BY CAST(trade_time AS INTEGER) DESC
    LIMIT 500;
  `;
  return await queryDb(sql, [sinceTimestamp]);
}

/**
 * Summarize top tickers by total premium in the last N minutes
 */
async function getTopTickers(minutes = 15) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  const sql = `
    SELECT ticker, SUM(premium) AS total_premium
    FROM option_trades
    WHERE type = 'call'
      AND CAST(trade_time AS INTEGER) >= ?
    GROUP BY ticker
    ORDER BY total_premium DESC
    LIMIT 5;
  `;
  return await queryDb(sql, [cutoff]);
}

/**
 * Detect unusual trades — high premium, low price, or short expiry
 */
async function detectUnusual(minutes = 15) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  const sql = `
    SELECT ticker, premium, strike, expiration, spot, type, trade_time
    FROM option_trades
    WHERE type = 'call'
      AND CAST(trade_time AS INTEGER) >= ?
      AND (premium >= 300000 OR strike IS NOT NULL)
    ORDER BY premium DESC
    LIMIT 50;
  `;
  return await queryDb(sql, [cutoff]);
}

module.exports = { getRecentTrades, getTopTickers, detectUnusual };
