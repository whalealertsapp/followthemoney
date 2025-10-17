// ===== IMPORTS =====
import dotenv from "dotenv";
import express from "express";
import crypto from "crypto";
import { Client, GatewayIntentBits, EmbedBuilder } from "discord.js";
import sqlite3 from "sqlite3";
import fetch from "node-fetch";
import cron from "node-cron";
import { DateTime } from "luxon";

import { getTopTickersFromDiscord } from "./tasks/aiMarketRecap.js";
import { detectUnusualFromDiscord } from "./tasks/aiUnusualFlow.js";

dotenv.config();

// ===== CONFIG =====
const {
  DISCORD_TOKEN,
  DEST_CHANNEL_ID,           // whale-alerts
  TOPDOG_CHANNEL_ID,
  RISKY_BIZ_CHANNEL_ID,
  PENNY_WHALES_CHANNEL_ID,
  ALERT_ROLE_ID,
  TOPDOG_ROLE_ID,

  // Unusual Whales
  UW_API_KEY,
  UW_API_URL = "https://api.unusualwhales.com/api/option-trades/flow-alerts?limit=100",

  // Whop roles / guild
  DISCORD_GUILD_ID,
  ROLE_BASIC,
  ROLE_PRO,
  ROLE_ELITE,
  WHOP_WEBHOOK_SECRET,

  // Misc
  POLL_MS = 30000,
  MIN_PREMIUM = 50000,
  DEBUG_MODE = "false",

  // AI summary channels
  MARKET_RECAP_CHANNEL_ID,
  UNUSUAL_FLOW_CHANNEL_ID,
} = process.env;

if (!DISCORD_TOKEN || !DEST_CHANNEL_ID || !ALERT_ROLE_ID || !UW_API_KEY) {
  console.error("❌ Missing required .env values.");
  process.exit(1);
}

// ===== DISCORD CLIENT =====
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
});

// ===== DB =====
async function initDB() {
  const db = new sqlite3.Database("./whales.db");
  await new Promise((resolve, reject) => {
    db.run(
      `CREATE TABLE IF NOT EXISTS whale_trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        uw_id TEXT UNIQUE,
        ticker TEXT,
        type TEXT,                -- 'call' or 'put'
        strike REAL,
        expiration TEXT,          -- yyyy-mm-dd
        avg_price REAL,
        contracts INTEGER,
        oi INTEGER,
        premium REAL,
        iv REAL,
        trade_time TEXT,          -- ISO
        source TEXT
      )`,
      (err) => (err ? reject(err) : resolve())
    );
  });
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
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

// ===== UTILS =====
const numFmt = (n) => `$${Number(n).toLocaleString()}`;
const robinhoodLink = (ticker) => `https://robinhood.com/options/chains/${ticker}`;

// ET market hours (DST-safe)
function isMarketOpen() {
  try {
    const nowET = DateTime.now().setZone("America/New_York");
    const day = nowET.weekday; // 1..7 (Mon..Sun)
    const minutes = nowET.hour * 60 + nowET.minute;
    const open = 9 * 60 + 30;
    const close = 16 * 60 + 30;
    const openNow = day >= 1 && day <= 5 && minutes >= open && minutes <= close;
    return openNow;
  } catch {
    return false;
  }
}

// ===== SAFE FETCH =====
async function safeFetch(url, options, retries = 3) {
  try {
    const res = await fetch(url, options);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  } catch (err) {
    if (retries > 0) {
      await new Promise((r) => setTimeout(r, 2000 * (4 - retries)));
      return safeFetch(url, options, retries - 1);
    }
    console.error("Fetch failed:", err.message);
    return { data: [] };
  }
}

// ===== DISCORD POSTS =====
async function postToChannel(channelId, contentOrPayload) {
  const channel = await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return false;
  await channel.send(contentOrPayload);
  return true;
}

async function postFlowAlert(t) {
  const embed = new EmbedBuilder()
    .setColor(t.type === "put" ? 0xe74c3c : 0x1abc9c)
    .setTitle(t.type === "put" ? "🔻 PUT Flow Alert" : "📊 Flow Alert")
    .addFields(
      { name: "Ticker", value: t.ticker, inline: true },
      { name: "Type", value: t.type.toUpperCase(), inline: true },
      { name: "Strike", value: `$${t.strike}`, inline: true },
      { name: "Expiry", value: t.expiration, inline: true },
      { name: "Avg Price", value: `$${t.avg_price}`, inline: true },
      { name: "Contracts", value: String(t.contracts), inline: true },
      { name: "OI", value: String(t.oi), inline: true },
      { name: "Premium", value: numFmt(t.premium), inline: true }
    )
    .setFooter({ text: `Trade Time: ${t.trade_time}` })
    .setDescription(`[View on Robinhood](${robinhoodLink(t.ticker)})`);

  await postToChannel(DEST_CHANNEL_ID, {
    content: `<@&${ALERT_ROLE_ID}>`,
    embeds: [embed],
  });
}

async function postMegaWhale(t, daysLeft) {
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
      { name: "Premium", value: numFmt(t.premium), inline: true }
    )
    .setFooter({ text: `Trade Time: ${t.trade_time}` })
    .setDescription(`[View on Robinhood](${robinhoodLink(t.ticker)})`);

  const msg = `💥 **${t.ticker.toUpperCase()} ${t.type.toUpperCase()}** — **${numFmt(
    t.premium
  )}** premium, exp in **${daysLeft}** days`;
  await postToChannel(DEST_CHANNEL_ID, msg);
  await postToChannel(DEST_CHANNEL_ID, { embeds: [embed] });
  if (TOPDOG_CHANNEL_ID) {
    await postToChannel(TOPDOG_CHANNEL_ID, msg);
    await postToChannel(TOPDOG_CHANNEL_ID, { embeds: [embed] });
  }
}

async function postRiskyBiz(t, daysLeft) {
  if (!RISKY_BIZ_CHANNEL_ID) return;
  const perContract =
    t.avg_price && t.avg_price > 0
      ? t.avg_price
      : t.contracts
      ? t.premium / (t.contracts * 100)
      : 0;

  const embed = new EmbedBuilder()
    .setColor(0xe74c3c)
    .setTitle("⚠️ Risky Biz Flow Alert (<10d Expiry)")
    .addFields(
      { name: "Ticker", value: t.ticker, inline: true },
      { name: "Type", value: t.type.toUpperCase(), inline: true },
      { name: "Strike", value: `$${t.strike}`, inline: true },
      { name: "Expiry", value: t.expiration, inline: true },
      { name: "Avg Price", value: `$${perContract.toFixed(2)}`, inline: true },
      { name: "Contracts", value: String(t.contracts), inline: true },
      { name: "Premium", value: numFmt(t.premium), inline: true }
    )
    .setDescription(`[View on Robinhood](${robinhoodLink(t.ticker)})`)
    .setFooter({ text: `Trade Time: ${t.trade_time}` });

  const msg = `⏳ **${t.ticker.toUpperCase()} ${t.type.toUpperCase()}** — ${numFmt(
    t.premium
  )}, expires in **${daysLeft}** days`;
  await postToChannel(RISKY_BIZ_CHANNEL_ID, msg);
  await postToChannel(RISKY_BIZ_CHANNEL_ID, { embeds: [embed] });
}

async function postPennyWhale(t) {
  if (!PENNY_WHALES_CHANNEL_ID) return;
  const perContract =
    t.avg_price && t.avg_price > 0
      ? t.avg_price
      : t.contracts
      ? t.premium / (t.contracts * 100)
      : 0;

  const embed = new EmbedBuilder()
    .setColor(0x3498db)
    .setTitle("🐋 Penny Whale Flow Alert (<$1 Contracts)")
    .addFields(
      { name: "Ticker", value: t.ticker, inline: true },
      { name: "Type", value: t.type.toUpperCase(), inline: true },
      { name: "Strike", value: `$${t.strike}`, inline: true },
      { name: "Expiry", value: t.expiration, inline: true },
      { name: "Avg Price", value: `$${perContract.toFixed(2)}`, inline: true },
      { name: "Contracts", value: String(t.contracts), inline: true },
      { name: "Premium", value: numFmt(t.premium), inline: true }
    )
    .setDescription(`[View on Robinhood](${robinhoodLink(t.ticker)})`)
    .setFooter({ text: `Trade Time: ${t.trade_time}` });

  await postToChannel(PENNY_WHALES_CHANNEL_ID, { embeds: [embed] });
}

async function postTopDogs(db, minutes) {
  const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
  const rows = await allSql(
    db,
    `SELECT ticker, SUM(premium) AS total
     FROM whale_trades
     WHERE trade_time >= ?
     GROUP BY ticker
     ORDER BY total DESC
     LIMIT 5`,
    [cutoff]
  );
  if (!rows?.length || !TOPDOG_CHANNEL_ID) return;

  let desc = `🪙 Money flow (last ${minutes}m):\n\n`;
  rows.forEach((r, i) => {
    desc += `#${i + 1} **${r.ticker}** — ${numFmt(r.total)}\n${robinhoodLink(r.ticker)}\n\n`;
  });

  const embed = new EmbedBuilder()
    .setColor(0xf39c12)
    .setTitle(`🔥 Top Dogs — Last ${minutes} minutes`)
    .setDescription(desc)
    .setTimestamp();

  await postToChannel(TOPDOG_CHANNEL_ID, { content: TOPDOG_ROLE_ID ? `<@&${TOPDOG_ROLE_ID}>` : "", embeds: [embed] });
}

// ===== POLLING: Unusual Whales =====
async function pollUW(db) {
  if (String(DEBUG_MODE).toLowerCase() === "true") console.log(`Poll UW every ${POLL_MS}ms`);
  const json = await safeFetch(UW_API_URL, { headers: { Authorization: `Bearer ${UW_API_KEY}` } });
  if (!json?.data) return;

  for (const t of json.data) {
    try {
      const normalized = {
        uw_id: t.id || `${t.ticker}-${t.strike}-${t.expiry}-${t.created_at}`,
        ticker: t.ticker,
        type: (t.type || "").toLowerCase(), // 'call'|'put'
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

      // Save once
      await runSql(
        db,
        `INSERT OR IGNORE INTO whale_trades
         (uw_id, ticker, type, strike, expiration, avg_price, contracts, oi, premium, iv, trade_time, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        Object.values(normalized)
      );

      console.log(
        `✅ Saved trade: ${normalized.ticker} ${normalized.type.toUpperCase()} $${normalized.strike} exp ${normalized.expiration} — Premium ${numFmt(
          normalized.premium
        )}`
      );

      // Always post main flow alert to Whale Alerts
      await postFlowAlert(normalized);

      // Derived conditions
      let daysLeft = 0;
      try {
        const expDate = new Date(`${normalized.expiration}T00:00:00Z`);
        const today = new Date();
        daysLeft = Math.ceil((expDate - today) / (1000 * 60 * 60 * 24));
      } catch {}

      // Mega Whale ($1M+)
      if (normalized.premium >= 1_000_000) {
        await postMegaWhale(normalized, daysLeft);
      }

      // Risky Biz (>$300k & <=10D)
      if (normalized.premium >= 300_000 && daysLeft > 0 && daysLeft <= 10) {
        await postRiskyBiz(normalized, daysLeft);
      }

      // Penny Whales (>=100k total & <$1 contract est)
      const perContract =
        normalized.avg_price && normalized.avg_price > 0
          ? normalized.avg_price
          : normalized.contracts
          ? normalized.premium / (normalized.contracts * 100)
          : 0;
      if (normalized.premium >= 100_000 && perContract > 0 && perContract <= 1.0) {
        await postPennyWhale({ ...normalized, avg_price: perContract });
      }
    } catch (err) {
      console.error("DB/processing error:", err.message);
    }
  }
}

// ===== AI SUMMARIES (market-hours gated) =====
async function runMarketRecap() {
  if (!isMarketOpen()) return;
  try {
    const recap = await getTopTickersFromDiscord();
    if (!recap || !MARKET_RECAP_CHANNEL_ID) return;
    await postToChannel(MARKET_RECAP_CHANNEL_ID, `🧠 **AI Market Recap:**\n${recap}`);
  } catch (err) {
    console.error("AI Market Recap failed:", err.message);
  }
}
async function runUnusualFlow() {
  if (!isMarketOpen()) return;
  try {
    const analysis = await detectUnusualFromDiscord();
    if (!analysis || !UNUSUAL_FLOW_CHANNEL_ID) return;
    await postToChannel(UNUSUAL_FLOW_CHANNEL_ID, `🚨 **AI Unusual Flow:**\n${analysis}`);
  } catch (err) {
    console.error("AI Unusual Flow failed:", err.message);
  }
}
async function runEndOfDaySummary() {
  try {
    const recap = await getTopTickersFromDiscord();
    if (!recap || !MARKET_RECAP_CHANNEL_ID) return;
    await postToChannel(MARKET_RECAP_CHANNEL_ID, `📅 **End of Day Summary:**\n${recap}`);
  } catch (err) {
    console.error("End of Day Summary failed:", err.message);
  }
}

// ===== WHOP WEBHOOK (role mapping) =====
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
      data.customer?.discord_id || data.discord_id || data.customer?.discord?.id;
    const productIds =
      data.line_items?.map((x) => x.product_id) || (data.product_id ? [data.product_id] : []);
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
    console.error("Whop webhook error:", err.message);
    res.status(200).send("ok");
  }
});

app.get("/", (_req, res) => res.status(200).send("OK"));
app.listen(3001, () => console.log("Whop webhook on /webhooks/whop"));

// ===== BOOT =====
(async () => {
  const db = await initDB();

  client.once("ready", async () => {
    console.log(`Logged in as ${client.user.tag}`);
    console.log("CALL & PUT Flow Enabled");

    // Poll UW (market hours)
    setInterval(async () => {
      if (isMarketOpen()) await pollUW(db);
    }, Number(POLL_MS));

    // Top Dogs every 10/30/60 minutes (market hours)
    for (const mins of [10, 30, 60]) {
      setInterval(async () => {
        if (isMarketOpen()) await postTopDogs(db, mins);
      }, mins * 60 * 1000);
    }

    // AI summaries every 30m (market hours), and EOD at 4:10pm ET (21:10 UTC)
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
})();
