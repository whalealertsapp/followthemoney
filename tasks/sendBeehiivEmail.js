// tasks/sendBeehiivEmail.js
import fetch from "node-fetch";
import dotenv from "dotenv";
import { generateEmailDigest } from "./emailDigest.js";

dotenv.config();

const API_KEY = process.env.BEEHIIV_API_KEY;
const PUB_ID = process.env.BEEHIIV_PUBLICATION_ID;

export async function sendBeehiivEmail() {
  try {
    const html = await generateEmailDigest();

    const res = await fetch(`https://api.beehiiv.com/v2/publications/${PUB_ID}/posts`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${API_KEY}`,
      },
body: JSON.stringify({
  publication_id: PUB_ID,
  title: "🐋 FOLLOW THE MONEY — Market Flow Update",   // <— required by Beehiiv
  subject: "🐋 FOLLOW THE MONEY — Market Flow Update",
  content_html: html,
  send_now: true,
}),


    });

    // 💡 Debug block to catch Beehiiv responses
    if (!res.ok) {
      const text = await res.text();
      console.error("❌ Beehiiv API error:", res.status, res.statusText);
      console.error("Response:", text);
      return;
    }

    const data = await res.json();
    console.log("✅ Email sent successfully:", data);
  } catch (err) {
    console.error("❌ Failed to send Beehiiv email:", err);
  }
}

// Run immediately if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  sendBeehiivEmail();
}
