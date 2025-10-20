// ===== IMPORTS =====
import { isMarketOpen, getMarketStatus } from "./utils/marketHours.js";

import dotenv from "dotenv";
dotenv.config();

import { createRequire } from "module";
const require = createRequire(import.meta.url);
const crypto = require("crypto");
const express = require("express");
const processedTrades = new Set();


import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";

// === AI Summaries (Discord-based) ===
import { getTopTickersFromDiscord } from "./tasks/aiMarketRecap.js";
import { detectUnusualFromDiscord } from "./tasks/aiUnusualFlow.js";
import cron from "node-cron";

// ===== HELPER: Send long messages safely =====
async function sendLongMessage(channel, text) {
  if (!channel || !text) return;

  // Split text into chunks of max 1990 chars (Discord limit = 2000)
  const chunks = text.match(/[\s\S]{1,1990}/g);

  for (const chunk of chunks) {
    try {
      await channel.send(chunk);
      await new Promise(r => setTimeout(r, 500)); // small delay to avoid rate limits
    } catch (err) {
      console.error("❌ Error sending chunk:", err);
    }
  }
}

// ===== CONFIG =====
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const DEST_CHANNEL_ID = process.env.DEST_CHANNEL_ID;   // whale-alerts
const TOPDOG_CHANNEL_ID = process.env.TOPDOG_CHANNEL_ID;
const RISKY_BIZ_CHANNEL_ID = process.env.RISKY_BIZ_CHANNEL_ID;
const PENNY_WHALES_CHANNEL_ID = process.env.PENNY_WHALES_CHANNEL_ID;
const ALERT_ROLE_ID = process.env.ALERT_ROLE_ID;
const TOPDOG_ROLE_ID = process.env.TOPDOG_ROLE_ID;
const UW_API_KEY = process.env.UW_API_KEY;
const UW_API_URL = process.env.UW_API_URL || "https://api.unusualwhales.com/api/option-trades/flow-alerts?limit=100";
const POLL_MS = Number(process.env.POLL_MS || 30000);
const MIN_PREMIUM = Number(process.env.MIN_PREMIUM || 50000);
const DEBUG_MODE = String(process.env.DEBUG_MODE || "").toLowerCase() === "true";

if (!DISCORD_TOKEN || !DEST_CHANNEL_ID || !ALERT_ROLE_ID || !UW_API_KEY) {
  console.error("❌ Missing required .env values. Check template.");
  process.exit(1);
}

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ===== DATABASE =====
async function initDB() {
  const db = new sqlite3.Database('./whales.db');

  // Create whale_trades table
  await new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS whale_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uw_id TEXT UNIQUE,
        ticker TEXT,
        type TEXT,
        strike REAL,
        expiration TEXT,
        avg_price REAL,
        contracts INTEGER,
        oi INTEGER,
        premium REAL,
        iv REAL,
        trade_time TEXT,
        source TEXT
      )`, (err) => err ? reject(err) : resolve());
  });

  // ✅ Add meta table for persistent settings like lastTradeTime
  await new Promise((resolve, reject) => {
    db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT
      );
    `, (err) => err ? reject(err) : resolve());
  });

  console.log("📂 Database ready: whales.db");
  return db;
}

function runSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

function allSql(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}


// ===== UTILS =====
const numFmt = (n) => `$${Number(n).toLocaleString()}`;
const robinhoodLink = (ticker) => `https://robinhood.com/options/chains/${ticker}`;

// ===== SAFE FETCH =====
async function safeFetch(url, options, retries = 3) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    if (retries > 0) {
      console.warn(`⚠️ Fetch failed (${err.code || err.message}), retrying...`);
      await new Promise(r => setTimeout(r, 2000 * (4 - retries)));
      return safeFetch(url, options, retries - 1);
    } else {
      console.error("❌ Fetch failed permanently:", err);
      return { data: [] };
    }
  }
}

// ===== POLL UW API =====
// 🧠 Prevent reposting identical trades across poll cycles

async function pollUW(db) {
  if (DEBUG_MODE) console.log(`⏳ Polling UW API every ${POLL_MS}ms...`);

  // 🕓 Skip API polling when market is closed
  if (!isMarketOpen()) {
    if (DEBUG_MODE) console.log("🕓 Market closed — skipping UW API poll.");
    return;
  }

  const json = await safeFetch(UW_API_URL, {
    headers: { Authorization: `Bearer ${UW_API_KEY}` },
  });

  if (!json?.data) {
    console.warn("⚠️ No trades returned from UW API");
    return;
  }

  if (DEBUG_MODE) console.log(`🔎 Retrieved ${json.data.length} trades`);

// ---- UW outage / stale-data check ----
if (Array.isArray(json.data) && json.data.length > 0) {
  const newestTradeTime = new Date(json.data[0].created_at || json.data[0].timestamp);
  const now = new Date();
  const estNow = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));

  // Compare the trade day to today's ET day
  if (newestTradeTime.getUTCDate() !== estNow.getDate()) {
    console.log("⚠️ UW API returning stale data — possible outage");
    return; // skip processing this poll cycle
  }
}

  // ✅ Load last saved timestamp from DB
  let lastTradeTime = 0;
  try {
    const rows = await allSql(db, 'SELECT value FROM meta WHERE key = "lastTradeTime"');
    if (rows.length > 0 && rows[0].value) {
      lastTradeTime = Number(rows[0].value);
    }
  } catch (err) {
    console.error("⚠️ Could not read lastTradeTime from DB:", err);
  }

  for (const t of json.data) {
    const tradeTimestamp = new Date(t.created_at).getTime();

    // 🚫 Skip if older than the last processed trade
    if (tradeTimestamp <= lastTradeTime) {
      if (DEBUG_MODE) console.log(`⏩ Skipping old trade (${t.ticker}) @ ${t.created_at}`);
      continue;
    }

    // 🧩 Create a unique fingerprint for this trade to prevent duplicates in same session
    const tradeKey = `${t.ticker}-${t.type}-${t.strike}-${t.expiry}-${t.created_at}-${t.total_premium}`;

    // 🚫 Skip if this trade was already processed during current runtime
    if (processedTrades.has(tradeKey)) {
      if (DEBUG_MODE) console.log(`⚠️ Skipping duplicate trade: ${tradeKey}`);
      continue;
    }

    // ✅ Mark it as processed
    processedTrades.add(tradeKey);

    // 🧹 Prevent memory growth (keep latest 5k trades)
    if (processedTrades.size > 5000) {
      const firstKey = processedTrades.values().next().value;
      processedTrades.delete(firstKey);
    }

    try {
      const normalized = {
        uw_id: t.id || `${t.ticker}-${t.strike}-${t.expiry}-${t.created_at}`,
        ticker: t.ticker,
        type: (t.type || "").toLowerCase(),
        strike: Number(t.strike),
        expiration: t.expiry,
        avg_price: Number(t.ask || t.price || 0),
        contracts: Number(t.total_size || t.contracts || 0),
        oi: Number(t.open_interest || t.oi || 0),
        premium: Number(t.total_premium || t.premium || 0),
        iv: Number(t.iv_start || t.iv || 0),
        trade_time: t.created_at,
        source: "UW_API",
      };

      // Skip invalid tickers or zero premiums
      if (!normalized.ticker || normalized.premium <= 0) continue;

      // === HANDLE CALL TRADES ===
      if (normalized.premium >= MIN_PREMIUM && normalized.type === "call") {
        const result = await runSql(
          db,
          `INSERT OR IGNORE INTO whale_trades
           (uw_id, ticker, type, strike, expiration, avg_price, contracts, oi, premium, iv, trade_time, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          Object.values(normalized)
        );

        if (result.changes > 0) {
          console.log(
            `✅ Saved trade: ${normalized.ticker} CALL $${normalized.strike} exp ${normalized.expiration} — Premium ${numFmt(normalized.premium)}`
          );

          await postTrade(normalized);

          let daysLeft = 0;
          try {
            const expDate = new Date(`${normalized.expiration}T00:00:00Z`);
            const today = new Date();
            daysLeft = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
          } catch {}

          if (normalized.premium >= 1_000_000) await postMegaWhale(normalized, daysLeft);
          if (normalized.premium >= 300_000 && daysLeft > 0 && daysLeft <= 10)
            await postShortFuseWhale(normalized, daysLeft);

          // ✅ Update lastTradeTime in memory and DB
          lastTradeTime = Math.max(lastTradeTime, tradeTimestamp);
          await runSql(
            db,
            'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
            ["lastTradeTime", lastTradeTime.toString()]
          );
        }
      }

      // === HANDLE PUT TRADES ===
      if (normalized.premium >= MIN_PREMIUM && normalized.type === "put") {
        const result = await runSql(
          db,
          `INSERT OR IGNORE INTO whale_trades
           (uw_id, ticker, type, strike, expiration, avg_price, contracts, oi, premium, iv, trade_time, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          Object.values(normalized)
        );

        if (result.changes > 0) {
          console.log(
            `✅ Saved trade: ${normalized.ticker} PUT $${normalized.strike} exp ${normalized.expiration} — Premium ${numFmt(normalized.premium)}`
          );

          await postPutTrade(normalized);

          // ✅ Update lastTradeTime for PUTs as well
          lastTradeTime = Math.max(lastTradeTime, tradeTimestamp);
          await runSql(
            db,
            'INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)',
            ["lastTradeTime", lastTradeTime.toString()]
          );
        }
      }

      // --- PENNY WHALE LOGIC ---
      const trueAvg =
        normalized.avg_price > 0
          ? normalized.avg_price
          : normalized.contracts > 0
          ? normalized.premium / (normalized.contracts * 100)
          : 0;

      if (normalized.premium >= 100_000 && trueAvg > 0 && trueAvg <= 1.0) {
        console.log(
          `🐋 Penny Whale detected: ${normalized.ticker} ${normalized.type.toUpperCase()} $${normalized.strike} exp ${normalized.expiration} — Avg $${trueAvg.toFixed(2)}, Premium ${numFmt(normalized.premium)}`
        );
        await postPennyWhale({ ...normalized, avg_price: trueAvg });
      }
    } catch (err) {
      console.error("❌ DB insert error:", err);
    }
  }

  if (DEBUG_MODE) console.log("✅ Poll cycle complete.");
}


// ===== POST TO DISCORD (Flow Alerts) =====
async function postTrade(t) {
  const channel = await client.channels.fetch(DEST_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(0x1abc9c)
    .setTitle("📊 Flow Alert")
    .addFields(
      { name: "Ticker", value: t.ticker, inline: true },
      { name: "Type", value: t.type.toUpperCase(), inline: true },
      { name: "Strike", value: `$${t.strike}`, inline: true },
      { name: "Expiry", value: t.expiration, inline: true },
      { name: "Avg Price", value: `$${t.avg_price}`, inline: true },
      { name: "Contracts", value: String(t.contracts), inline: true },
      { name: "OI", value: String(t.oi), inline: true },
      { name: "Premium", value: numFmt(t.premium), inline: true },
    )
    .setFooter({ text: `Trade Time: ${t.trade_time}` })
    .setDescription(`[View on Robinhood](${robinhoodLink(t.ticker)})`);

  await channel.send({
    content: `<@&${ALERT_ROLE_ID}>`,
    embeds: [embed],
  });
}

// ===== POST MEGA WHALE ALERTS (> $1M) =====
async function postMegaWhale(t, daysLeft) {
  const whale = await client.channels.fetch(DEST_CHANNEL_ID).catch(() => null);
  const topdog = await client.channels.fetch(TOPDOG_CHANNEL_ID).catch(() => null);
  if (!whale) return;

  const msg = `💥 Someone just bought **${numFmt(t.premium)}** of **${t.ticker.toUpperCase()} calls** expiring in ${daysLeft} days!`;

  const embed = new EmbedBuilder()
    .setColor(0xe67e22)
    .setTitle("🐳 Mega Whale Alert +$1M")
    .addFields(
      { name: "Ticker", value: t.ticker, inline: true },
      { name: "Type", value: t.type.toUpperCase(), inline: true },
      { name: "Strike", value: `$${t.strike}`, inline: true },
      { name: "Expiry", value: t.expiration, inline: true },
      { name: "Avg Price", value: `$${t.avg_price}`, inline: true },
      { name: "Contracts", value: String(t.contracts), inline: true },
      { name: "OI", value: String(t.oi), inline: true },
      { name: "Premium", value: numFmt(t.premium), inline: true },
    )
    .setFooter({ text: `Trade Time: ${t.trade_time}` })
    .setDescription(`[View on Robinhood](${robinhoodLink(t.ticker)})`);

  await whale.send(msg);
  await whale.send({ embeds: [embed] });
  if (topdog) {
    await topdog.send(msg);
    await topdog.send({ embeds: [embed] });
  }
}

// ===== RISKY BIZ ALERTS (<10D, >$300K) =====
async function postShortFuseWhale(t, daysLeft) {
  const risky = await client.channels.fetch(RISKY_BIZ_CHANNEL_ID).catch(() => null);
  const whale = await client.channels.fetch(DEST_CHANNEL_ID).catch(() => null);
  if (!risky && !whale) return;

  let avgPrice = Number(t.avg_price);
  if (!avgPrice || avgPrice === 0) {
    const perContract = t.contracts ? t.premium / (t.contracts * 100) : 0;
    avgPrice = perContract > 0 ? perContract : 0;
  }

  const msg = `⏳ Someone just bought **${numFmt(t.premium)}** of **${t.ticker.toUpperCase()} calls** expiring in only ${daysLeft} days!`;

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("⚠️ Risky Biz Flow Alert (<10d Expiry)")
    .setDescription(`[View on Robinhood](${robinhoodLink(t.ticker)})`)
    .addFields(
      { name: "Ticker", value: t.ticker, inline: true },
      { name: "Type", value: t.type.toUpperCase(), inline: true },
      { name: "Strike", value: `$${t.strike}`, inline: true },
      { name: "Expiry", value: t.expiration, inline: true },
      { name: "Avg Price", value: `$${avgPrice.toFixed(2)}`, inline: true },
      { name: "Contracts", value: String(t.contracts), inline: true },
      { name: "OI", value: String(t.oi), inline: true },
      { name: "Premium", value: numFmt(t.premium), inline: true },
    )
    .setFooter({ text: `Trade Time: ${t.trade_time}` });

  if (whale) {
    await whale.send(msg);
    await whale.send({ embeds: [embed] });
  }
  if (risky) {
    await risky.send(msg);
    await risky.send({ embeds: [embed] });
  }
}

// ===== PENNY WHALE ALERTS (<$1 Contracts) =====
async function postPennyWhale(t) {
  const penny = await client.channels.fetch(PENNY_WHALES_CHANNEL_ID).catch(() => null);
  if (!penny) return;

  let avgPrice = Number(t.avg_price);
  if (!avgPrice || avgPrice === 0) {
    const perContract = t.contracts ? t.premium / (t.contracts * 100) : 0;
    avgPrice = perContract > 0 ? perContract : 0;
  }

  const msg = `🐋 Penny Whale Alert\nSomeone just bought **${numFmt(t.premium)}** of **${t.ticker.toUpperCase()} calls**\n` +
              `Strike: **$${t.strike}** | Expiry: **${t.expiration}**\n` +
              `Price per contract: **$${avgPrice.toFixed(2)}** | Contracts: **${t.contracts}**\n` +
              `${robinhoodLink(t.ticker)}`;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("🐋 Penny Whale Flow Alert (<$1 Contracts)")
    .setDescription(`[View on Robinhood](${robinhoodLink(t.ticker)})`)
    .addFields(
      { name: "Ticker", value: t.ticker, inline: true },
      { name: "Type", value: t.type.toUpperCase(), inline: true },
      { name: "Strike", value: `$${t.strike}`, inline: true },
      { name: "Expiry", value: t.expiration, inline: true },
      { name: "Avg Price", value: `$${avgPrice.toFixed(2)}`, inline: true },
      { name: "Contracts", value: String(t.contracts), inline: true },
      { name: "Premium", value: numFmt(t.premium), inline: true },
    )
    .setFooter({ text: `Trade Time: ${t.trade_time}` });

  await penny.send(msg);
  await penny.send({ embeds: [embed] });
}

// ===== POST TOP DOGS =====
async function postTopDogs(db, minutes) {
  const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
  const rows = await allSql(db, `
    SELECT ticker, SUM(premium) as total_premium
    FROM whale_trades
    WHERE trade_time >= ?
    GROUP BY ticker
    ORDER BY total_premium DESC
    LIMIT 5
  `, [cutoff]);

  if (!rows || rows.length === 0) return;

  const channel = await client.channels.fetch(TOPDOG_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  let description = "🪙 The most money flowed into these companies in the last " + minutes + " minutes:\n\n";
  rows.forEach((row, i) => {
    description += `#${i + 1}: **${row.ticker}** — ${numFmt(row.total_premium)}\n${robinhoodLink(row.ticker)}\n\n`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle(`🔥 Top Dogs — Last ${minutes} minutes`)
    .setDescription(description)
    .setTimestamp();

  await channel.send({ content: `<@&${TOPDOG_ROLE_ID}>`, embeds: [embed] });
}

// ===== POST PUT Flow Alerts =====
async function postPutTrade(t) {
  try {
    const channel = await client.channels.fetch(DEST_CHANNEL_ID).catch(() => null);
    if (!channel) {
      console.warn("⚠️ PUT flow channel not found.");
      return;
    }

    const embed = new EmbedBuilder()
      .setColor(0xe74c3c)
      .setTitle("🔻 PUT Flow Alert")
      .addFields(
        { name: "Ticker", value: t.ticker || "N/A", inline: true },
        { name: "Type", value: (t.type || "PUT").toUpperCase(), inline: true },
        { name: "Strike", value: `$${t.strike}`, inline: true },
        { name: "Expiry", value: t.expiration || "N/A", inline: true },
        { name: "Avg Price", value: `$${t.avg_price || 0}`, inline: true },
        { name: "Contracts", value: String(t.contracts || 0), inline: true },
        { name: "Open Interest", value: String(t.oi || 0), inline: true },
        { name: "Premium", value: numFmt(t.premium), inline: true },
      )
      .setFooter({ text: `Trade Time: ${t.trade_time || "Unknown"}` })
      .setDescription(`[View on Robinhood](${robinhoodLink(t.ticker)})`);

    await channel.send({
      content: `<@&${ALERT_ROLE_ID}>`,
      embeds: [embed],
    });

    // 🗞️ Inline related headlines (optional)
    if (typeof postTickerNewsInline === "function") {
      await postTickerNewsInline(t.ticker, channel);
    }

    console.log(`✅ Posted PUT alert for ${t.ticker}`);
  } catch (err) {
    console.error("❌ Failed to post PUT alert:", err);
  }
}

// ===== CONFIG (add near your other IDs) =====
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || "";

// ===== DISCORD LOGGER (add once anywhere near the top of the file) =====
class DiscordLogger {
  constructor(client, channelId) {
    this.client = client;
    this.channelId = channelId;
    this.queue = [];
    this.sending = false;
    this.bound = false;
    this.channel = null;
    this.intervalMs = 1000; // 1 msg/sec to be gentle on rate limits
  }

  async bind() {
    if (!this.channelId) return;
    try {
      this.channel = await this.client.channels.fetch(this.channelId);
      this.bound = true;
    } catch (e) {
      // Don’t crash the bot if the channel is missing; just log once.
      this.bound = false;
      console.__orig?.call(console, "⚠️ LOG FEED disabled: invalid LOG_CHANNEL_ID or missing permissions.");
    }
  }

  enqueue(line) {
    if (!this.bound || !this.channel) return;
    // Discord message limit = 2000 chars. Split long lines just in case.
    const chunks = this.splitToChunks(line, 1900);
    for (const c of chunks) this.queue.push(c);
    if (!this.sending) this.processQueue();
  }

  splitToChunks(str, size) {
    const out = [];
    let i = 0;
    while (i < str.length) {
      out.push(str.slice(i, i + size));
      i += size;
    }
    return out.length ? out : [str];
  }

  async processQueue() {
    this.sending = true;
    while (this.queue.length && this.bound && this.channel) {
      const msg = this.queue.shift();
      try {
        await this.channel.send({ content: msg });
      } catch (e) {
        // If we can’t send, pause briefly and retry next tick.
        await new Promise(r => setTimeout(r, 1500));
      }
      await new Promise(r => setTimeout(r, this.intervalMs));
    }
    this.sending = false;
  }
}

// ===== PATCH console.log to mirror into Discord (add once after client is defined) =====
const discordLogger = new DiscordLogger(client, LOG_CHANNEL_ID);

// Keep an original reference so we still log to terminal.
if (!console.__orig) console.__orig = console.log;

// ===== PATCH console.log to mirror into Discord =====
console.log = (...args) => {
  const line = args
    .map(a =>
      typeof a === "string"
        ? a
        : (() => {
            try {
              return JSON.stringify(a);
            } catch {
              return String(a);
            }
          })()
    )
    .join(" ");

  console.__orig(line); // keep terminal output

  // ✅ Only post these "Saved trade" lines to Discord log channel
  if (line.startsWith("✅ Saved trade:")) {
    discordLogger.enqueue(line);
  }
};


// ===== INIT =====
let db;
(async () => {
  db = await initDB();

// ===== LOAD LAST TRADE TIMESTAMP (persistent anti-duplicate) =====
let lastTradeTime = 0;

try {
  const rows = await allSql(db, 'SELECT value FROM meta WHERE key = "lastTradeTime"');
  if (rows.length > 0 && rows[0].value) {
    lastTradeTime = Number(rows[0].value);
    console.log(`🕒 Resuming from last posted trade: ${new Date(lastTradeTime).toLocaleString()}`);
  } else {
    console.log("🆕 No previous trade record found — starting fresh.");
  }
} catch (err) {
  console.error("⚠️ Could not load lastTradeTime from DB:", err);
}

  client.once("ready", async () => {
  console.log(`🚀 Logged in as ${client.user.tag}`);
  await discordLogger.bind();
  console.log("✅ CALL & PUT Flow Enabled");

  setInterval(() => pollUW(db), POLL_MS);
  setInterval(() => postTopDogs(db, 10), 10 * 60 * 1000);
  setInterval(() => postTopDogs(db, 30), 30 * 60 * 1000);
  setInterval(() => postTopDogs(db, 60), 60 * 60 * 1000);
});

// ===== WHOP WEBHOOK LISTENER (AUTO ROLE ASSIGN) =====
const app = express();
app.use(express.json({ type: "*/*" }));

function verifyWhop(req) {
  const sig = req.headers["whop-signature"];
  if (!sig) return false;
  const hmac = crypto.createHmac("sha256", process.env.WHOP_WEBHOOK_SECRET);
  hmac.update(JSON.stringify(req.body));
  const digest = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(sig));
}

async function manageRole(discordId, roleId, action) {
  const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  if (action === "add") await member.roles.add(roleId).catch(() => {});
  else await member.roles.remove(roleId).catch(() => {});
}

app.post("/webhooks/whop", async (req, res) => {
console.log("📩 Incoming webhook from Whop:", req.body);

  try {
    const event = req.body.event || req.body.type;
    const data = req.body.data || {};


    const discordId =
      data.customer?.discord_id ||
      data.discord_id ||
      data.customer?.discord?.id;

    const productIds =
      data.line_items?.map((x) => x.product_id) ||
      (data.product_id ? [data.product_id] : []);

    if (!discordId || productIds.length === 0) return res.status(200).send("ok");

    const productToRole = {
      prod_basicflow: process.env.ROLE_BASIC,
      prod_proflow: process.env.ROLE_PRO,
      prod_eliteflow: process.env.ROLE_ELITE,
      prod_founderscircle: process.env.ROLE_ELITE,
    };

    const addEvents = [
      "order.paid",
      "subscription.activated",
      "subscription.renewed",
      "membership_went_valid",
    ];
    const removeEvents = [
      "order.refunded",
      "subscription.canceled",
      "subscription.expired",
      "membership_went_invalid",
    ];

    for (const pid of productIds) {
      const roleId = productToRole[pid];
      if (!roleId) continue;
      if (addEvents.includes(event)) await manageRole(discordId, roleId, "add");
      else if (removeEvents.includes(event)) await manageRole(discordId, roleId, "remove");
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error("Whop webhook error:", err);
    res.status(200).send("ok");
  }
});

const PORT = process.env.PORT || 3001;

// ---- START EXPRESS SERVER SAFELY ----
if (!process.env.RENDER || process.env.NODE_APP_INSTANCE === "0") {
  app.listen(PORT, () => console.log(`🚀 Listening on port ${PORT}`));
} else {
  console.log(`⚙️ Skipping duplicate Express bind on port ${PORT}`);
}


  await client.login(DISCORD_TOKEN);
})();


// ---- SCHEDULED EXECUTION ----
async function postFlowTally() {
  console.log("📊 (postFlowTally placeholder) — skipped");
}

cron.schedule(
  "*/30 * * * *",
  async () => {
    if (!isMarketOpen()) {
      console.log(`🕓 Market is ${getMarketStatus()} — skipping cron tasks.`);
      return;
    }

    console.log("⏰ Running AI Market Recap...");
    await getTopTickersFromDiscord();

    console.log("⏰ Running AI Unusual Flow...");
    await detectUnusualFromDiscord();

    console.log("⏰ Posting Flow Tally...");
    await postFlowTally();
  },
  { timezone: "America/New_York" }
);


// ===== MANUAL TRIGGERS (for Render Shell or Local Testing) =====
if (process.argv.includes("--recap")) {
  console.log("🧠 Manual trigger: AI Market Recap");
  runMarketRecap().then(() => process.exit(0));
}

if (process.argv.includes("--flow")) {
  console.log("🚨 Manual trigger: AI Unusual Flow");
  runUnusualFlow().then(() => process.exit(0));
}

if (process.argv.includes("--tally")) {
  console.log("📊 Manual trigger: Flow Tally");
  postFlowTally().then(() => process.exit(0));
}


// ---- END OF DAY SUMMARY ----
async function runEndOfDaySummary() {
  try {
    const recap = await getTopTickersFromDiscord(); // reuse top-dogs Discord data
    if (!recap || recap.length === 0) {
      console.warn("⚠️ No data found for end-of-day summary.");
      return;
    }

    const channel = await client.channels.fetch(process.env.MARKET_RECAP_CHANNEL_ID);
    if (channel) {
      await channel.send(`📅 **End of Day Summary:**\n${recap}\n\n📈 Market closed. See you tomorrow!`);
      console.log("✅ Posted End of Day Summary");
    }
  } catch (err) {
    console.error("End of Day Summary failed:", err);
  }
}

cron.schedule(
  "5 16 * * 1-5",
  async () => {
    console.log("🔔 Market closed — posting final Flow Tally...");
    await postFlowTally(true); // You can check for this flag in flowTally.js
  },
  { timezone: "America/New_York" }
);
