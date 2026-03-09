// api/cron.js — Vercel Cron endpoint for scheduled tasks
// Configured in vercel.json: runs daily at 8:00 AM ET (12:00 UTC)
// Tasks: daily health audit, weekly deep audit, premarket data check
// Sends results via the multi-channel SMS system (api/sms.js)

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  // Verify this is a legitimate cron call (Vercel sets this header)
  const authHeader = req.headers['authorization'];
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const { task } = req.query;
  const baseUrl = `https://${req.headers.host}`;

  try {
    switch (task || 'daily') {

      // ── Daily health audit (8am ET every weekday)
      case 'daily': {
        // Fetch current market data via our own proxy
        const [btcR, mstrR, fgR] = await Promise.allSettled([
          fetch(`${baseUrl}/api/proxy?source=coingecko&type=spot`).then(r => r.json()),
          fetch(`${baseUrl}/api/proxy?source=yahoo&type=quote`).then(r => r.json()),
          fetch(`${baseUrl}/api/proxy?source=fg`).then(r => r.json()),
        ]);

        const btcData = btcR.status === 'fulfilled' ? btcR.value : null;
        const btcPrice = btcData?.market_data?.current_price?.usd || 0;
        const mstrData = mstrR.status === 'fulfilled' ? mstrR.value : null;
        const mstrChart = mstrData?.chart?.result?.[0];
        const mstrPrice = mstrChart?.indicators?.quote?.[0]?.close?.filter(v => v != null).at(-1) || 0;
        const fgData = fgR.status === 'fulfilled' ? fgR.value : null;
        const fgValue = fgData?.data?.[0]?.value || '?';

        // Compute NAV
        const nav = mstrPrice > 0 ? (btcPrice * 720737) / (mstrPrice * 332270000) : 0;

        const summary = [
          `FOLATAC DAILY CHECK (${new Date().toISOString().split('T')[0]})`,
          `BTC $${btcPrice.toLocaleString()} | MSTR $${mstrPrice.toFixed(2)} | NAV ${nav.toFixed(3)}x`,
          `F&G: ${fgValue}`,
          nav < 1.0 ? `⚠ NAV below 1.0x — discount territory` : '',
          btcPrice < 55000 ? `⚠ BTC below $55K — PATH B` : '',
          btcPrice < 45500 ? `🔴 BTC below $45.5K — ALL-IN ARM ZONE` : '',
        ].filter(Boolean).join('\n');

        // Send via SMS system
        const phones = [process.env.USER_PHONE, process.env.GF_PHONE].filter(Boolean);
        if (phones.length > 0 || process.env.TELEGRAM_CHAT_ID) {
          for (const phone of phones) {
            await fetch(`${baseUrl}/api/sms`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                to: phone,
                message: summary,
                telegramChatId: process.env.TELEGRAM_CHAT_ID,
              }),
            });
          }
          // Also send to Telegram if configured and no phones
          if (phones.length === 0 && process.env.TELEGRAM_CHAT_ID) {
            await fetch(`${baseUrl}/api/sms`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                message: summary,
                telegramChatId: process.env.TELEGRAM_CHAT_ID,
              }),
            });
          }
        }

        return res.json({ ok: true, task: 'daily', summary });
      }

      // ── Weekly deep audit (Monday 8am ET)
      case 'weekly': {
        // Run the AI health audit
        const [btcR, mstrR] = await Promise.allSettled([
          fetch(`${baseUrl}/api/proxy?source=coingecko&type=spot`).then(r => r.json()),
          fetch(`${baseUrl}/api/proxy?source=yahoo&type=quote`).then(r => r.json()),
        ]);

        const btcPrice = btcR.status === 'fulfilled' ? (btcR.value?.market_data?.current_price?.usd || 0) : 0;
        const mstrChart = mstrR.status === 'fulfilled' ? mstrR.value?.chart?.result?.[0] : null;
        const mstrPrice = mstrChart?.indicators?.quote?.[0]?.close?.filter(v => v != null).at(-1) || 0;
        const nav = mstrPrice > 0 ? (btcPrice * 720737) / (mstrPrice * 332270000) : 0;

        // Call Claude for audit
        const auditR = await fetch(`${baseUrl}/api/ai`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            action: 'audit',
            mktCtx: { btc: btcPrice, mstr: mstrPrice, ivr: 50, nav, allin: 0 },
            portCtx: { p1s: 0, p2s: 0, leaps: 0 },
          }),
        });
        const auditData = await auditR.json();
        const auditText = auditData?.result || 'Audit unavailable';

        const message = `FOLATAC WEEKLY AUDIT:\n${auditText}`;

        // Deliver
        const phones = [process.env.USER_PHONE, process.env.GF_PHONE].filter(Boolean);
        for (const phone of phones) {
          await fetch(`${baseUrl}/api/sms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ to: phone, message, telegramChatId: process.env.TELEGRAM_CHAT_ID }),
          });
        }
        if (phones.length === 0 && process.env.TELEGRAM_CHAT_ID) {
          await fetch(`${baseUrl}/api/sms`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message, telegramChatId: process.env.TELEGRAM_CHAT_ID }),
          });
        }

        return res.json({ ok: true, task: 'weekly', audit: auditText.slice(0, 200) });
      }

      default:
        return res.status(400).json({ error: `Unknown task: ${task}` });
    }
  } catch (err) {
    console.error('[cron] error:', err.message);
    return res.status(500).json({ error: err.message });
  }
}
