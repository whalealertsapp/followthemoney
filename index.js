// ===== IMPORTS =====
import dotenv from "dotenv";
import express from "express";
import crypto from "crypto";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import cron from "node-cron";
import { DateTime } from "luxon"; // ✅ added for timezone-safe logic

// === AI Summaries (Discord-based) ===
import { getTopTickersFromDiscord } from "./tasks/aiMarketRecap.js";
import { detectUnusualFromDiscord } from "./tasks/aiUnusualFlow.js";

dotenv.config();

// ===== HELPER: Send long messages safely =====
async function sendLongMessage(channel, text) {
  if (!channel || !text) return;
  const chunks = text.match(/[\s\S]{1,1990}/g);
  for (const chunk of chunks) {
    try {
      await channel.send(chunk);
      await new Promise(r => setTimeout(r, 500));
    } catch (err) {
      console.error("❌ Error sending chunk:", err);
    }
  }
}

// ===== CONFIG =====
const {
  DISCORD_TOKEN,
  DEST_CHANNEL_ID,
  TOPDOG_CHANNEL_ID,
  RISKY_BIZ_CHANNEL_ID,
  PENNY_WHALES_CHANNEL_ID,
  ALERT_ROLE_ID,
  TOPDOG_ROLE_ID,
  UW_API_KEY,
  UW_API_URL = "https://api.unusualwhales.com/api/option-trades/flow-alerts?limit=100", // ✅ now includes puts
  POLL_MS = 30000,
  MIN_PREMIUM = 50000,
  DEBUG_MODE = "false",
  LOG_CHANNEL_ID,
  DISCORD_GUILD_ID,
  ROLE_BASIC,
  ROLE_PRO,
  ROLE_ELITE,
  WHOP_WEBHOOK_SECRET
} = process.env;

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
  const db = new sqlite3.Database("./whales.db");
  await new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS whale_trades (
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
      )`,
      (err) => (err ? reject(err) : resolve())
    );
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
async function pollUW(db) {
  if (String(DEBUG_MODE).toLowerCase() === "true") console.log(`⏳ Polling UW API every ${POLL_MS}ms...`);
  const json = await safeFetch(UW_API_URL, { headers: { Authorization: `Bearer ${UW_API_KEY}` } });
  if (!json?.data) return;

  for (const t of json.data) {
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

      if (!normalized.ticker || normalized.premium <= 0) continue;

      // === CALL TRADES ===
      if (normalized.premium >= MIN_PREMIUM && normalized.type === "call") {
        await runSql(
          db,
          `INSERT OR IGNORE INTO whale_trades
           (uw_id, ticker, type, strike, expiration, avg_price, contracts, oi, premium, iv, trade_time, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          Object.values(normalized)
        );
        console.log(
          `✅ Saved trade: ${normalized.ticker} CALL $${normalized.strike} exp ${normalized.expiration} — Premium ${numFmt(normalized.premium)}`
        );
        await postTrade(normalized);
      }

      // === PUT TRADES ===
      if (normalized.premium >= MIN_PREMIUM && normalized.type === "put") {
        await runSql(
          db,
          `INSERT OR IGNORE INTO whale_trades
           (uw_id, ticker, type, strike, expiration, avg_price, contracts, oi, premium, iv, trade_time, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          Object.values(normalized)
        );
        console.log(
          `✅ Saved trade: ${normalized.ticker} PUT $${normalized.strike} exp ${normalized.expiration} — Premium ${numFmt(normalized.premium)}`
        );
        await postPutTrade(normalized);
      }
    } catch (err) {
      console.error("❌ DB insert error:", err);
    }
  }
}

// ===== POST TO DISCORD =====
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
      { name: "Premium", value: numFmt(t.premium), inline: true }
    )
    .setFooter({ text: `Trade Time: ${t.trade_time}` });
  await channel.send({ content: `<@&${ALERT_ROLE_ID}>`, embeds: [embed] });
}

async function postPutTrade(t) {
  const channel = await client.channels.fetch(DEST_CHANNEL_ID).catch(() => null);
  if (!channel) return;
  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("🔻 PUT Flow Alert")
    .addFields(
      { name: "Ticker", value: t.ticker, inline: true },
      { name: "Type", value: t.type.toUpperCase(), inline: true },
      { name: "Strike", value: `$${t.strike}`, inline: true },
      { name: "Expiry", value: t.expiration, inline: true },
      { name: "Premium", value: numFmt(t.premium), inline: true }
    )
    .setFooter({ text: `Trade Time: ${t.trade_time}` });
  await channel.send({ content: `<@&${ALERT_ROLE_ID}>`, embeds: [embed] });
}

// ===== MARKET HOURS CHECK (LUXON - DST SAFE) =====
function isMarketOpen() {
  try {
    const nowET = DateTime.now().setZone("America/New_York");
    const day = nowET.weekday; // 1-5 Mon–Fri
    const minutes = nowET.hour * 60 + nowET.minute;
    const open = 9 * 60 + 30;
    const close = 16 * 60 + 30;
    const isOpen = day >= 1 && day <= 5 && minutes >= open && minutes <= close;
    console.log(`🕒 Market check [${nowET.toFormat("ccc HH:mm")}] → ${isOpen ? "OPEN" : "CLOSED"}`);
    return isOpen;
  } catch (err) {
    console.error("Error checking market hours:", err);
    return false;
  }
}

// ===== AI SUMMARIES =====
async function runMarketRecap() {
  if (!isMarketOpen()) return;
  try {
    const recap = await getTopTickersFromDiscord();
    if (!recap) return;
    const channel = await client.channels.fetch(process.env.MARKET_RECAP_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    await channel.send(`🧠 **AI Market Recap:**\n${recap}`);
  } catch (err) {
    console.error("AI Market Recap failed:", err);
  }
}

async function runUnusualFlow() {
  if (!isMarketOpen()) return;
  try {
    const analysis = await detectUnusualFromDiscord();
    if (!analysis) return;
    const channel = await client.channels.fetch(process.env.UNUSUAL_FLOW_CHANNEL_ID).catch(() => null);
    if (!channel) return;
    await channel.send(`🚨 **AI Unusual Flow:**\n${analysis}`);
  } catch (err) {
    console.error("AI Unusual Flow failed:", err);
  }
}

async function runEndOfDaySummary() {
  try {
    const recap = await getTopTickersFromDiscord();
    if (!recap) return;
    const channel = await client.channels.fetch(process.env.MARKET_RECAP_CHANNEL_ID).catch(() => null);
    if (channel) await channel.send(`📅 **End of Day Summary:**\n${recap}`);
  } catch (err) {
    console.error("End of Day Summary failed:", err);
  }
}

// ===== WHOP WEBHOOK LISTENER =====
const app = express();
app.use(express.json({ type: "*/*" }));

async function manageRole(discordId, roleId, action) {
  const guild = await client.guilds.fetch(DISCORD_GUILD_ID);
  const member = await guild.members.fetch(discordId).catch(() => null);
  if (!member) return;
  if (action === "add") await member.roles.add(roleId).catch(() => {});
  else await member.roles.remove(roleId).catch(() => {});
}

app.post("/webhooks/whop", async (req, res) => {
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
      prod_basicflow: ROLE_BASIC,
      prod_proflow: ROLE_PRO,
      prod_eliteflow: ROLE_ELITE,
    };
    const addEvents = ["order.paid", "subscription.activated", "subscription.renewed"];
    const removeEvents = ["order.refunded", "subscription.canceled", "subscription.expired"];
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

app.listen(3001, () => console.log("🚀 Whop webhook listening on /webhooks/whop"));

// ===== MAIN WRAPPER =====
(async () => {
  const db = await initDB();

  client.once("ready", async () => {
    console.log(`🚀 Logged in as ${client.user.tag}`);
    console.log("✅ CALL & PUT Flow Enabled");

    setInterval(async () => {
      if (isMarketOpen()) await pollUW(db);
    }, POLL_MS);

    for (const mins of [10, 30, 60]) {
      setInterval(async () => {
        if (isMarketOpen()) await postTopDogs(db, mins);
      }, mins * 60 * 1000);
    }

    cron.schedule("*/30 * * * *", async () => {
      if (!isMarketOpen()) return;
      await runMarketRecap();
      await runUnusualFlow();
    });
    cron.schedule("10 21 * * 1-5", async () => {
      await runEndOfDaySummary();
    });
  });

  await client.login(DISCORD_TOKEN);
})(); // ✅ properly closed async IIFE
