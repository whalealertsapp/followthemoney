const fetch = require('node-fetch');
const FINNHUB_API = process.env.FINNHUB_API_KEY;

async function fetchNews(ticker) {
  try {
    const now = new Date();
    const from = new Date(now - 48 * 3600 * 1000).toISOString().split('T')[0];
    const to = now.toISOString().split('T')[0];
    const url = `https://finnhub.io/api/v1/company-news?symbol=${ticker}&from=${from}&to=${to}&token=${FINNHUB_API}`;
    const res = await fetch(url);
    const data = await res.json();
    return data.slice(0, 2).map(n => n.headline);
  } catch (e) {
    console.error('News fetch failed for', ticker, e);
    return [];
  }
}

module.exports = { fetchNews };