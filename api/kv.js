// api/kv.js — Cross-device persistent storage via Vercel KV
// Requires Vercel KV database connected to project (see SETUP.md)
// Falls back gracefully if KV not configured

export const config = { runtime: 'nodejs' };

// Dynamically import @vercel/kv — graceful fallback if not installed
async function getKV() {
  try {
    const { kv } = await import('@vercel/kv');
    return kv;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const kv = await getKV();

  // GET — retrieve a value
  if (req.method === 'GET') {
    const { key } = req.query;
    if (!key) return res.status(400).json({ error: 'key required' });

    if (!kv) {
      // KV not configured — tell client to use localStorage
      return res.status(503).json({ error: 'KV not configured', fallback: true });
    }

    try {
      const value = await kv.get(`folatac:${key}`);
      if (value === null || value === undefined) return res.json(null);
      return res.json({ value });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // POST — store a value
  if (req.method === 'POST') {
    const { key, value } = req.body;
    if (!key) return res.status(400).json({ error: 'key required' });

    if (!kv) {
      return res.status(503).json({ error: 'KV not configured', fallback: true });
    }

    try {
      // Store with 1-year TTL (in seconds)
      await kv.set(`folatac:${key}`, value, { ex: 365 * 24 * 3600 });
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // DELETE
  if (req.method === 'DELETE') {
    const { key } = req.query;
    if (!key || !kv) return res.status(400).json({ error: 'bad request' });
    try {
      await kv.del(`folatac:${key}`);
      return res.json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed' });
}
