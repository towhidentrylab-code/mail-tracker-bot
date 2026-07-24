const DISCORD_BOT_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = process.env.DISCORD_CHANNEL_ID;
const GAS_WEBAPP_URL = process.env.GAS_WEBAPP_URL;
const INGEST_SECRET = process.env.INGEST_SECRET;

function assertEnv(name, value) {
  if (!value) {
    console.error(`Missing required environment variable / secret: ${name}`);
    process.exit(1);
  }
}

assertEnv('DISCORD_BOT_TOKEN', DISCORD_BOT_TOKEN);
assertEnv('DISCORD_CHANNEL_ID', DISCORD_CHANNEL_ID);
assertEnv('GAS_WEBAPP_URL', GAS_WEBAPP_URL);
assertEnv('INGEST_SECRET', INGEST_SECRET);

function isImageAttachment(att) {
  if (att.content_type && att.content_type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp)$/i.test(att.filename || '');
}

async function main() {
  const url = `https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages?limit=50`;

  const res = await fetch(url, {
    headers: {
      Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
      'User-Agent': 'DiscordBot (https://github.com, 1.0) MailTrackerPoller/1.0',
    },
  });

  if (!res.ok) {
    console.error('Discord API error:', res.status, await res.text());
    process.exit(1);
  }

  const messages = await res.json();
  console.log(`Fetched ${messages.length} recent messages from the channel.`);

  let sent = 0;
  let skipped = 0;

  for (const msg of messages) {
    if (!msg.attachments || msg.attachments.length === 0) continue;

    for (const att of msg.attachments) {
      if (!isImageAttachment(att)) continue;

      const payload = {
        secret: INGEST_SECRET,
        messageId: msg.id,
        imageUrl: att.url,
        timestamp: msg.timestamp,
      };

      const postRes = await fetch(GAS_WEBAPP_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'follow',
      });

      const text = await postRes.text();
      let parsed = null;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // non-JSON response, keep raw text for logging
      }

      if (parsed && parsed.skipped) {
        skipped++;
        console.log(`Message ${msg.id}: already logged, skipped.`);
      } else if (parsed && parsed.ok) {
        sent++;
        console.log(`Message ${msg.id}: sent and processed.`);
      } else {
        console.error(`Message ${msg.id}: unexpected response ->`, postRes.status, text);
      }
    }
  }

  console.log(`Done. New: ${sent}, already logged: ${skipped}.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
