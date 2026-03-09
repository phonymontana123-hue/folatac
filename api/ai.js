// api/ai.js — Server-side Anthropic API proxy
// Anthropic key lives in env var, never sent to browser

export const config = { runtime: 'nodejs' };

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' });

  const { action, ...body } = req.body;

  const headers = {
    'Content-Type':      'application/json',
    'x-api-key':         apiKey,
    'anthropic-version': '2023-06-01',
  };

  try {
    switch (action) {

      // ── Parse brokerage screenshot(s) — supports up to 10 images
      case 'screenshot': {
        const { b64, mediaType, images } = body;
        const PROMPT = [
          'You are parsing brokerage account screenshot(s) for an MSTR options strategy.',
          'There may be multiple screenshots showing different parts of the same portfolio.',
          'Combine data from ALL images into a single unified result.',
          'Extract ALL visible data. Return ONLY valid JSON, no markdown:',
          '{ "p1OpenContracts":0, "p2OpenContracts":0, "p1AssignedShares":0, "p2AssignedShares":0,',
          '  "p1LEAPContracts":0, "p2LEAPContracts":0, "p1TierACash":null, "p2TierACash":null,',
          '  "p1TotalAccountValue":null, "p2TotalAccountValue":null,',
          '  "p1ShareCostBasis":null, "p2ShareCostBasis":null, "mstrPrice":null,',
          '  "recentlyClosedPositions":[], "recentlyPurchasedLeaps":[],',
          '  "openPositions":"", "confidence":"high", "notes":null }',
          'recentlyClosedPositions: [{strike, contracts, premium, result:expired/assigned, date}]',
          'recentlyPurchasedLeaps: [{strike, contracts, costPerContract, date}]',
          'Use null for unknown values. Never guess. Only report clearly visible data.',
        ].join('\n');

        // Build content array with all images
        const contentParts = [];
        if (images && images.length > 0) {
          // Multi-image mode
          for (const img of images) {
            contentParts.push({ type: 'image', source: { type: 'base64', media_type: img.mediaType || 'image/png', data: img.b64 } });
          }
        } else if (b64) {
          // Single image (backwards compatible)
          contentParts.push({ type: 'image', source: { type: 'base64', media_type: mediaType || 'image/png', data: b64 } });
        }
        contentParts.push({ type: 'text', text: PROMPT });

        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers,
          body: JSON.stringify({
            model: 'claude-sonnet-4-6', max_tokens: 1200,
            messages: [{ role: 'user', content: contentParts }],
          }),
        });
        const d = await r.json();
        const raw = d.content?.[0]?.text || '';
        const clean = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
        const match = clean.match(/\{[\s\S]*\}/);
        const result = match ? JSON.parse(match[0]) : null;
        return res.json({ result });
      }

      // ── Weekly health audit
      case 'audit': {
        const { mktCtx, portCtx } = body;
        const prompt = [
          'MSTR options strategy health check. No markdown. Facts and math only.',
          `Market: BTC $${(mktCtx.btc||0).toFixed(0)}, MSTR $${(mktCtx.mstr||0).toFixed(2)}, IVR ${mktCtx.ivr||0}, NAV ${(mktCtx.nav||0).toFixed(3)}x`,
          `Portfolio: P1shares=${portCtx.p1s}, P2shares=${portCtx.p2s}, LEAPs=${portCtx.leaps}, All-In=${mktCtx.allin}/3`,
          'P1=margin spread account. P2=cash-secured naked puts (GF, no Kelly needed).',
          'Output exactly 5 lines: GRADE / THESIS / PORTFOLIO / ACTION / RISK.',
        ].join('\n');
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers,
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 400, messages: [{ role: 'user', content: prompt }] }),
        });
        const d = await r.json();
        return res.json({ result: d.content?.[0]?.text || null });
      }

      // ── Natural language SMS assistant
      case 'sms': {
        const { msg, mktCtx, portCtx } = body;
        const system = [
          'You are FOLATAC, MSTR strategy assistant. No emotion. Facts only. Under 160 chars when possible.',
          `BTC $${(mktCtx.btc||0).toFixed(0)} | MSTR $${(mktCtx.mstr||0).toFixed(2)} | IVR ${mktCtx.ivr||0} | NAV ${(mktCtx.nav||0).toFixed(3)}x | All-In ${mktCtx.allin||0}/3`,
          `P1shares=${portCtx.p1s||0} | P2shares=${portCtx.p2s||0} | LEAPs=${portCtx.leaps||0}`,
          'P1=margin spread. P2=cash-secured naked puts (GF). Income to Tier C per routing%.',
        ].join('\n');
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers,
          body: JSON.stringify({ model: 'claude-sonnet-4-6', max_tokens: 250, system, messages: [{ role: 'user', content: msg }] }),
        });
        const d = await r.json();
        return res.json({ result: d.content?.[0]?.text || null });
      }

      // ── API health check
      case 'ping': {
        return res.json({ ok: true, model: 'claude-sonnet-4-6' });
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

  } catch (err) {
    console.error(`[ai] error action=${action}:`, err.message);
    res.status(500).json({ error: err.message });
  }
}
