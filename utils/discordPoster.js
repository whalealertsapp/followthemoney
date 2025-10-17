const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages] });

function getTimestamp() {
  const now = new Date();
  return now.toLocaleString('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });
}

function parseSummaryText(text) {
  return text
    .split(/\n+/)
    .filter((l) => l.trim().length > 0)
    .slice(0, 5);
}

function extractDollarAmount(line) {
  const match = line.match(/\$([\d,.]+)\s*(M|K)?/i);
  if (!match) return 0;
  let amount = parseFloat(match[1].replace(/,/g, ''));
  const suffix = match[2]?.toUpperCase();
  if (suffix === 'M') amount *= 1_000_000;
  else if (suffix === 'K') amount *= 1_000;
  return amount;
}

function extractTicker(line) {
  const match = line.match(/\b([A-Z]{1,5})\b/);
  return match ? match[1] : '';
}

function colorScale(baseColor, intensity) {
  const r = (baseColor >> 16) & 255;
  const g = (baseColor >> 8) & 255;
  const b = baseColor & 255;
  const mix = (x) => Math.min(255, Math.floor(x * (0.5 + intensity * 0.5)));
  return (mix(r) << 16) | (mix(g) << 8) | mix(b);
}

async function postToDiscord(channelId, text) {
  if (!client.isReady()) await client.login(process.env.DISCORD_TOKEN);
  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error(`Channel not found: ${channelId}`);

  const timestamp = getTimestamp();
  const isMarketRecap = channelId === process.env.AI_MARKET_RECAP_CHANNEL_ID;
  const isUnusual = channelId === process.env.AI_UNUSUAL_FLOW_CHANNEL_ID;

  const header = isMarketRecap
    ? `📊 AI Market Recap — ${timestamp} ET`
    : `⚠️ AI Unusual Flow — ${timestamp} ET`;

  const lines = parseSummaryText(text);
  const baseColor = isMarketRecap ? 0x22c55e : 0xfacc15;
  const emojis = isMarketRecap ? ['👍', '👀'] : ['🚨', '💰'];

  const premiums = lines.map(extractDollarAmount);
  const maxPremium = Math.max(...premiums, 1);

  const embeds = lines.map((line, i) => {
    const val = premiums[i];
    const intensity = Math.min(1, val / maxPremium);
    const embedColor = colorScale(baseColor, intensity);

    const ticker = extractTicker(line);
    const formattedAmount =
      val >= 1_000_000
        ? `$${(val / 1_000_000).toFixed(1)}M`
        : val >= 1_000
        ? `$${(val / 1_000).toFixed(0)}K`
        : val > 0
        ? `$${val}`
        : '';

    let title;
if (formattedAmount && ticker) {
  title = `💰 ${formattedAmount} — ${ticker} Calls`;
} else if (ticker) {
  title = `${ticker} Calls`;
} else {
  title = '📈 Market Activity'; // fallback for empty lines
}


    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setFooter({ text: `${timestamp} ET` })
      .setDescription(line);

if (i === 0) {
  embed.setTitle(header);
} else if (title && title.trim().length > 0) {
  embed.setTitle(title);
} else {
  embed.setTitle('📊 Flow Summary');
}


    return embed;
  });

  const message = await channel.send({ embeds });

  for (const emoji of emojis) {
    try {
      await message.react(emoji);
    } catch (e) {
      console.error('Failed to react with', emoji, e);
    }
  }
}

module.exports = { postToDiscord };
