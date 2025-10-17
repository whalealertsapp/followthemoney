// ===== /tasks/syncTrades.js (Fixed DB handle order) =====
const sqlite3 = require('sqlite3').verbose();
const DB_PATH = './whales.db';

// Minimum premium to record (tune as you like)
const PREMIUM_THRESHOLD = 50000;

let running = false;

function ensureSchema(db) {
  db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS option_trades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ticker TEXT,
      premium REAL,
      strike REAL,
      expiration TEXT,
      spot REAL,
      type TEXT,
      trade_time TEXT
    )`);

    db.run(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_option_trades_uniq
       ON option_trades(ticker, strike, expiration, trade_time)`
    );

    db.run(`CREATE INDEX IF NOT EXISTS idx_option_trades_time ON option_trades(trade_time)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_whale_trades_time ON whale_trades(trade_time)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_whale_trades_filter ON whale_trades(type, premium)`);
  });
}

function syncTradesOnce() {
  if (running) return;
  running = true;

  const db = new sqlite3.Database(DB_PATH);
  ensureSchema(db);

  db.get(`SELECT IFNULL(MAX(trade_time), 0) AS last_time FROM option_trades`, (e, row) => {
    if (e) {
      console.error('❌ last_time query error:', e.message);
      db.close();
      running = false;
      return;
    }

    const lastTime = row?.last_time || 0;

    const sql = `
      SELECT ticker, premium, strike, expiration, NULL AS spot, type, trade_time
      FROM whale_trades
      WHERE type = 'call'
        AND premium >= ?
        AND trade_time > ?
      ORDER BY trade_time ASC
      LIMIT 1000
    `;

    db.all(sql, [PREMIUM_THRESHOLD, lastTime], (err, rows) => {
      if (err) {
        console.error('❌ Sync select error:', err.message);
        db.close();
        running = false;
        return;
      }

      if (!rows || rows.length === 0) {
        db.close();
        running = false;
        return;
      }

      const stmt = db.prepare(`
        INSERT OR IGNORE INTO option_trades
        (ticker, premium, strike, expiration, spot, type, trade_time)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      let inserted = 0;
      for (const r of rows) {
        stmt.run(
          [r.ticker, r.premium, r.strike, r.expiration, r.spot, r.type, r.trade_time],
          (insErr) => {
            if (!insErr) inserted++;
          }
        );
      }

      stmt.finalize(() => {
        db.run(
          `DELETE FROM option_trades WHERE strftime('%s','now')*1000 - 86400000 > CAST(trade_time AS INTEGER)`,
          () => {
            if (inserted > 0) console.log(`✅ Synced ${inserted} new trades → option_trades.`);
            db.close();
            running = false;
          }
        );
      });
    });
  });
}

// Allow manual run: `node tasks/syncTrades.js`
if (require.main === module) {
  syncTradesOnce();
}

module.exports = { syncTradesOnce };
