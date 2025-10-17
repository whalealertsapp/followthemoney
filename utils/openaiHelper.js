const OpenAI = require('openai');
const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

async function callOpenAI(prompt) {
  const completion = await client.chat.completions.create({
    model: 'gpt-5',
    messages: [{ role: 'user', content: prompt }],
  });
  return completion.choices[0].message.content.trim();
}

async function generateMarketRecap(topTickers, newsData) {
  const prompt = `
Generate a concise market recap summarizing the top 5 tickers by call-buy volume in the last 15 minutes.
Include each ticker, premium total, and 3 sentences of relevant recent news context.
Format it as a short Discord post.
Tickers: ${JSON.stringify(topTickers)}
News: ${JSON.stringify(newsData)}
`;
  return await callOpenAI(prompt);
}

async function generateUnusualSummary(unusualTrades) {
  const prompt = `
Summarize the 5 most unusual option trades detected in the last 15 minutes.
Explain briefly why each stands out (e.g., deep OTM, short expiration, or unusually large premium) and include 2 sentences with recent relevant news/rumors/leaks.
Format as a short alert post.
Trades: ${JSON.stringify(unusualTrades)}
`;
  return await callOpenAI(prompt);
}

module.exports = { generateMarketRecap, generateUnusualSummary };