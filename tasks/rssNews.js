// ===== RSS News Integration for WhaleAlerts =====
import dotenv from "dotenv";
import RSSParser from "rss-parser";
import sqlite3 from "sqlite3";
dotenv.config();

const parser = new RSSParser();

// ===== CONFIG =====
const MARKET_NEWS_CHANNEL_ID = process.env.MARKET_NEWS_CHANNEL_ID || null;
const FEEDS = [
  "https://finance.yahoo.com/rss/topstories", // Yahoo Finance - CNBC mirrored
  "https://feeds.a.dj.com/rss/RSSMarketsMain.xml", // WSJ Markets
  "https://www.investing.com/rss/news.rss", // Investing.com
  "https://news.google.com/rss/search?q=stock+market&hl=en-US&gl=US&ceid=US:en", // Google Finance aggregator
  "https://www.marketwatch.com/feeds/topstories" // MarketWatch - Business headlines
];

// ===== STATE =====
let cachedHeadlines = [];          // stores { title, link, pubDate, source }
let postedLinks = new Set();       // avoid duplicate posts
let clientRef = null;              // discord client reference

// ===== HELPERS =====
async function fetchRecentHeadlines() {
  const headlines = [];
  for (const url of FEEDS) {
    try {
      // manually fetch XML with robust browser headers
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
          "Referer": "https://www.google.com"
        }
      });
      if (!res.ok) throw new Error(`Status ${res.status}`);
      const xml = await res.text();

      // parse feed XML text
      const feed = await parser.parseString(xml);
      (feed.items || []).slice(0, 15).forEach(item => {
        const title = item.title?.trim();
        const link = item.link;
        if (title && link && !postedLinks.has(link)) {
          headlines.push({
            title,
            link,
            pubDate: item.pubDate || new Date().toISOString(),
            source: new URL(url).hostname.replace("www.", "")
          });
        }
      });
    } catch (err) {
      if (!err.message.includes("fetch failed")) {
        console.warn(`⚠️ RSS fetch error for ${url}: ${err.message}`);
      }
    }
  }

  if (headlines.length > 0)
    cachedHeadlines = headlines.concat(cachedHeadlines).slice(0, 100);

  return cachedHeadlines;
}

function findHeadlinesForTicker(ticker) {
  const upperTicker = ticker.toUpperCase();
  return cachedHeadlines.filter(h =>
    h.title.toUpperCase().includes(upperTicker) ||
    h.title.toUpperCase().includes(` ${upperTicker} `)
  ).slice(0, 2);
}

// ===== INLINE POSTING =====
export async function postTickerNewsInline(ticker, channel) {
  if (!ticker || !channel) return;

  if (cachedHeadlines.length === 0) await fetchRecentHeadlines();

  const matches = findHeadlinesForTicker(ticker);
  if (matches.length === 0) return;

  const icons = {
    "finance.yahoo.com": "🟣",
    "dj.com": "📊",
    "investing.com": "📈",
    "marketwatch.com": "💰",
    "news.google.com": "📰"
  };

  let msg = "🗞️ **Related Headlines:**\n";
  msg += matches
    .map(h => {
      const icon = icons[h.source] || "🗞️";
      const cleanSource = h.source.replace("finance.", "").replace("www.", "");
      return `${icon} [${h.title}](${h.link}) — *${cleanSource}*`;
    })
    .join("\n");

  try {
    await channel.send(msg);
    matches.forEach(m => postedLinks.add(m.link));
  } catch (err) {
    console.warn("⚠️ Failed to post related news:", err.message);
  }
}

// ===== TOP TICKERS FROM WHALE DB =====
async function getTopTickersLastHour() {
  return new Promise((resolve) => {
    const db = new sqlite3.Database("./whales.db", sqlite3.OPEN_READONLY, (err) => {
      if (err) {
        console.warn("⚠️ Could not open whales.db:", err.message);
        return resolve([]);
      }
    });

    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    db.all(
      `SELECT ticker, COUNT(*) AS count
       FROM whale_trades
       WHERE CAST(strftime('%s', trade_time) AS INTEGER) * 1000 >= ?
       GROUP BY ticker
       ORDER BY count DESC
       LIMIT 5;`,
      [oneHourAgo],
      (err, rows) => {
        db.close();
        if (err) {
          console.warn("⚠️ DB query error:", err.message);
          return resolve([]);
        }
        resolve(rows.map(r => r.ticker.toUpperCase()));
      }
    );
  });
}

// ===== DIGEST POSTING =====
async function postHourlyDigest() {
  if (!clientRef || !MARKET_NEWS_CHANNEL_ID) return;
  const channel = await clientRef.channels.fetch(MARKET_NEWS_CHANNEL_ID).catch(() => null);
  if (!channel) return;

  const topTickers = await getTopTickersLastHour();
  const recent = cachedHeadlines.slice(0, 20);
  if (recent.length === 0 && topTickers.length === 0) return;

  let summary = "📰 **Market News Digest (Last Hour)**\n";
  if (topTickers.length > 0)
    summary += `🦈 **Top Flow Symbols:** ${topTickers.join(", ")}\n\n`;

  if (recent.length > 0)
    summary += recent.map(h => `• [${h.title}](${h.link}) — *${h.source}*`).join("\n");

  try {
    await channel.send(summary);
    recent.forEach(h => postedLinks.add(h.link));
  } catch (err) {
    console.warn("⚠️ Failed to post hourly digest:", err.message);
  }
}

// ===== MAIN STARTER =====
export function startNewsFeed(client) {
  clientRef = client;
  console.log("🗞️ RSS News Feed initialized.");

  fetchRecentHeadlines(); // Initial fetch

  // Refresh every 10 minutes
  setInterval(fetchRecentHeadlines, 10 * 60 * 1000);

  // Post digest every 60 minutes (only if channel set)
  if (MARKET_NEWS_CHANNEL_ID) {
    setInterval(postHourlyDigest, 60 * 60 * 1000);
  }
}
