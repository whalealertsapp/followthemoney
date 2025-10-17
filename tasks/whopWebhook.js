import express from "express";
import crypto from "crypto";
import { Client, GatewayIntentBits } from "discord.js";
import dotenv from "dotenv";
dotenv.config();

const app = express();
app.use(express.json({ type: "*/*" }));

// Discord bot setup
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});
await client.login(process.env.DISCORD_TOKEN);

const guild = await client.guilds.fetch(process.env.DISCORD_GUILD_ID);

// Map Whop product IDs → Discord Role IDs
const PRODUCT_TO_ROLE = {
  // example placeholders – replace with your real IDs
  "prod_whalealerts": process.env.ROLE_WHALE_ALERTS,
  "prod_topdogs": process.env.ROLE_TOP_DOGS,
  "prod_elite": process.env.ROLE_ELITE,
};

// Verify Whop signature (optional)
function verifyWhop(req) {
  const signature = req.headers["whop-signature"];
  if (!signature) return false;
  const hmac = crypto.createHmac("sha256", process.env.WHOP_WEBHOOK_SECRET);
  hmac.update(JSON.stringify(req.body));
  const digest = `sha256=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(digest), Buffer.from(signature));
}

// Assign or remove Discord role
async function manageRole(userId, roleId, action) {
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;
  if (action === "add") await member.roles.add(roleId).catch(() => {});
  else await member.roles.remove(roleId).catch(() => {});
}

app.post("/webhooks/whop", async (req, res) => {
  try {
    // optional: uncomment after testing
    // if (!verifyWhop(req)) return res.status(401).send("Invalid signature");

    const event = req.body.event || req.body.type;
    const data = req.body.data || {};

    const discordId =
      data.customer?.discord_id ||
      data.discord_id ||
      data.customer?.discord?.id;

    const productIds =
      data.line_items?.map((x) => x.product_id) ||
      (data.product_id ? [data.product_id] : []);

    if (!discordId || productIds.length === 0)
      return res.status(200).send("ok");

    const addEvents = [
      "order.paid",
      "subscription.activated",
      "subscription.renewed",
    ];
    const removeEvents = [
      "order.refunded",
      "subscription.canceled",
      "subscription.expired",
    ];

    for (const productId of productIds) {
      const roleId = PRODUCT_TO_ROLE[productId];
      if (!roleId) continue;
      if (addEvents.includes(event)) await manageRole(discordId, roleId, "add");
      else if (removeEvents.includes(event))
        await manageRole(discordId, roleId, "remove");
    }

    res.status(200).send("ok");
  } catch (err) {
    console.error(err);
    res.status(200).send("ok");
  }
});

app.listen(3001, () =>
  console.log("✅ Whop webhook running on http://localhost:3001/webhooks/whop")
);



~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
ADD TO ENV WHEN READY TO TEST


# Whop Integration
WHOP_WEBHOOK_SECRET=ws_100fb...e0a3170e    # copy full secret from Whop dashboard
DISCORD_GUILD_ID=YOUR_SERVER_ID            # right-click your Discord server → Copy ID

# Product ↔ Role mapping
ROLE_WHALE_ALERTS=1422369560589238404      # same as ALERT_ROLE_ID
ROLE_TOP_DOGS=1422630051148468365
ROLE_RISKY_BIZ=1423380815059878041
ROLE_PENNY_WHALES=1423659190542667796
ROLE_ELITE=1422369560589238404             # optional or your top-tier role if different

