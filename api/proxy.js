// api/proxy.js — Server-side proxy for all external data APIs
// API keys stored in Vercel env vars — NEVER sent to browser
// Options data: Yahoo Finance (primary) → Tradier Sandbox (backup) → MarketData.app (tertiary)
// All options responses cached 5 min to survive transient outages

export const config = { runtime: 'nodejs' };

// ── In-memory options cache (survives within single serverless invocation window)
// Vercel keeps warm instances ~5-15 min, so this provides meaningful caching
const optionsCache = {};
function getCached(key, maxAgeMs = 300_000) {
  const entry = optionsCache[key];
  if (entry && Date.now() - entry.ts < maxAgeMs) return entry.data;
  return null;
}
function setCache(key, data) {
  optionsCache[key] = { data, ts: Date.now() };
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { source, endpoint, ...params } = req.query;

  try {
    let data;

    switch (source) {

      // ── BTC price + 90d chart via CoinGecko
      case 'coingecko': {
        const type = params.type || 'spot';
        if (type === 'spot') {
          const r = await fetch(
            'https://api.coingecko.com/api/v3/coins/bitcoin?localization=false&tickers=false&community_data=false&developer_data=false'
          );
          data = await r.json();
        } else {
          const r = await fetch(
            'https://api.coingecko.com/api/v3/coins/bitcoin/market_chart?vs_currency=usd&days=90&interval=daily'
          );
          data = await r.json();
        }
        break;
      }

      // ── BTC fallback via Kraken (no key needed)
      case 'kraken': {
        const r = await fetch('https://api.kraken.com/0/public/Ticker?pair=XBTUSD');
        data = await r.json();
        break;
      }

      // ── Yahoo Finance (primary — no key needed)
      // Provides: MSTR price, 1-year daily OHLCV history, near-term options chain, Dec 2028 LEAP chain
      // ATM IV sourced directly from options impliedVolatility field.
      // IV Rank computed via Parkinson's HV estimator over 252-day history.
      // RVol ratio (10D÷30D HV) computed from close prices — fully automated.
      case 'yahoo': {
        const yType = params.type || 'quote';
        const yHeaders = {
          'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json,text/plain,*/*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Origin': 'https://finance.yahoo.com',
          'Referer': 'https://finance.yahoo.com/',
        };
        const yBase = 'https://query1.finance.yahoo.com';
        const yBase2 = 'https://query2.finance.yahoo.com'; // fallback host

        const yFetch = async (url) => {
          let r = await fetch(url.replace(yBase, yBase), { headers: yHeaders });
          if (!r.ok) r = await fetch(url.replace(yBase, yBase2), { headers: yHeaders });
          return r;
        };

        if (yType === 'history') {
          // 1-year daily OHLCV — used for Parkinson's IV, IV Rank, and RVol ratio
          const r = await yFetch(`${yBase}/v8/finance/chart/MSTR?interval=1d&range=1y&includeAdjustedClose=false`);
          data = await r.json();
        } else if (yType === 'options') {
          // Near-term options chain — cached 5 min (options data survives Yahoo blips)
          const cacheKey = 'yahoo_options';
          const cached = getCached(cacheKey);
          if (cached) { data = cached; break; }
          const r = await yFetch(`${yBase}/v7/finance/options/MSTR`);
          data = await r.json();
          if (data?.optionChain?.result?.[0]) setCache(cacheKey, data);
        } else if (yType === 'leapoptions') {
          // Dec 2028 LEAP chain — cached 5 min
          const cacheKey = 'yahoo_leapoptions';
          const cached = getCached(cacheKey);
          if (cached) { data = cached; break; }
          const r = await yFetch(`${yBase}/v7/finance/options/MSTR?date=1860883200`);
          data = await r.json();
          if (data?.optionChain?.result?.[0]) setCache(cacheKey, data);
        } else {
          // Default: current quote — 2-day chart gives last close + current price
          const r = await yFetch(`${yBase}/v8/finance/chart/MSTR?interval=1d&range=2d&includePrePost=false`);
          data = await r.json();
        }
        break;
      }

      // ── Fear & Greed (no key needed)
      case 'fg': {
        const r = await fetch('https://api.alternative.me/fng/?limit=1');
        data = await r.json();
        break;
      }

      // ── Fear & Greed backup via CoinyBubble (free, no signup, ~1 min updates)
      case 'fg2': {
        const r = await fetch('https://api.coinybubble.com/v1/fear-greed');
        if (!r.ok) return res.status(r.status).json({ error: `CoinyBubble HTTP ${r.status}` });
        data = await r.json();
        break;
      }

      // ── CryptoPanic news (no key needed)
      case 'news': {
        const r = await fetch(
          'https://cryptopanic.com/api/free/v1/posts/?currencies=BTC&filter=important&public=true'
        );
        data = await r.json();
        break;
      }

      // ── CoinGecko news (free, no key — backup news source)
      case 'news_coingecko': {
        const r = await fetch('https://api.coingecko.com/api/v3/news?per_page=15');
        if (!r.ok) return res.status(r.status).json({ error: `CoinGecko news HTTP ${r.status}` });
        data = await r.json();
        break;
      }

      // ── NewsData.io (free tier, 200 req/day — MSTR + BTC news with sentiment)
      case 'newsdata': {
        const key = process.env.NEWSDATA_KEY;
        if (!key) return res.status(503).json({ error: 'NEWSDATA_KEY not configured' });
        // topic param controls which thesis category to search
        const topic = params.topic || 'mstr';
        const queries = {
          mstr:   'MicroStrategy OR MSTR OR Saylor OR "bitcoin treasury"',
          regulation: '"crypto regulation" OR "SEC crypto" OR "SAB 121" OR "crypto bill" OR "digital asset regulation"',
          banking: '"bank crypto" OR "bank bitcoin" OR "OCC crypto" OR "bank deregulation" OR "institutional bitcoin"',
          macro:  '"Federal Reserve" OR "quantitative easing" OR "stealth QE" OR "M2 money supply" OR "bank reserves"',
          adoption: '"bitcoin ETF" OR "sovereign bitcoin" OR "strategic bitcoin reserve" OR "nation state bitcoin" OR "MSCI crypto"',
        };
        const q = encodeURIComponent(queries[topic] || queries.mstr);
        const r = await fetch(
          `https://newsdata.io/api/1/news?apikey=${key}&q=${q}&language=en&category=business,politics`
        );
        if (!r.ok) return res.status(r.status).json({ error: `NewsData HTTP ${r.status}` });
        data = await r.json();
        break;
      }

      // ── Finnhub company news for MSTR (free, 60 req/min — already have key)
      case 'finnhub_news': {
        const token = process.env.FINNHUB_KEY;
        if (!token) return res.status(503).json({ error: 'FINNHUB_KEY not configured' });
        const today = new Date().toISOString().split('T')[0];
        const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
        const nType = params.type || 'company';
        if (nType === 'company') {
          const r = await fetch(`https://finnhub.io/api/v1/company-news?symbol=MSTR&from=${weekAgo}&to=${today}&token=${token}`);
          if (!r.ok) return res.status(r.status).json({ error: `Finnhub news HTTP ${r.status}` });
          data = await r.json();
        } else {
          // General market news
          const r = await fetch(`https://finnhub.io/api/v1/news?category=general&minId=0&token=${token}`);
          if (!r.ok) return res.status(r.status).json({ error: `Finnhub general news HTTP ${r.status}` });
          data = await r.json();
        }
        break;
      }

      // ── SEC EDGAR RSS — MSTR filings (free, no key, real-time)
      // Tracks 8-K, 10-Q, 10-K, insider transactions for MicroStrategy
      case 'sec_edgar': {
        const cik = '0001050446'; // MicroStrategy CIK
        const r = await fetch(
          `https://efts.sec.gov/LATEST/search-index?q=%22MicroStrategy%22&dateRange=custom&startdt=${new Date(Date.now()-30*86400000).toISOString().split('T')[0]}&enddt=${new Date().toISOString().split('T')[0]}&forms=8-K,10-Q,10-K,4`,
          { headers: { 'User-Agent': 'FOLATAC Strategy Monitor contact@folatac.com', 'Accept': 'application/json' } }
        );
        if (!r.ok) {
          // Fallback to EDGAR full-text search
          const r2 = await fetch(
            `https://efts.sec.gov/LATEST/search-index?q=%22MicroStrategy%22&forms=8-K,10-Q,10-K,4`,
            { headers: { 'User-Agent': 'FOLATAC Strategy Monitor contact@folatac.com', 'Accept': 'application/json' } }
          );
          if (!r2.ok) return res.status(r2.status).json({ error: `SEC EDGAR HTTP ${r2.status}` });
          data = await r2.json();
        } else {
          data = await r.json();
        }
        break;
      }

      // ── FRED API — Federal Reserve Economic Data (free, no key for basic endpoints)
      // Tracks: Fed funds rate, M2 money supply, reverse repo, bank reserves
      case 'fred': {
        const series = params.series || 'FEDFUNDS';
        const allowed = [
          'FEDFUNDS',      // Federal funds effective rate
          'M2SL',          // M2 money supply
          'RRPONTSYD',     // Reverse repo (ON RRP)
          'WRESBAL',       // Reserve balances with Fed
          'WALCL',         // Fed total assets (balance sheet size)
          'TOTRESNS',      // Total reserves of depository institutions
        ];
        if (!allowed.includes(series)) return res.status(400).json({ error: `Unknown FRED series: ${series}` });
        const fredKey = process.env.FRED_KEY;
        if (!fredKey) return res.status(503).json({ error: 'FRED_KEY not configured' });
        const r = await fetch(
          `https://api.stlouisfed.org/fred/series/observations?series_id=${series}&api_key=${fredKey}&sort_order=desc&limit=30&file_type=json`
        );
        if (!r.ok) return res.status(r.status).json({ error: `FRED HTTP ${r.status}` });
        data = await r.json();
        break;
      }

      // ── GNews.io — broad financial/political news (free, 100 req/day)
      // Covers: regulation, Fed policy, banking, macro — not just crypto
      case 'gnews': {
        const key = process.env.GNEWS_KEY;
        if (!key) return res.status(503).json({ error: 'GNEWS_KEY not configured' });
        const topic = params.topic || 'crypto_regulation';
        const queries = {
          crypto_regulation: '"crypto regulation" OR "SEC bitcoin" OR "digital asset" OR "stablecoin bill"',
          fed_policy: '"Federal Reserve" OR "interest rate" OR "quantitative easing" OR "balance sheet"',
          banking_crypto: '"bank crypto" OR "bank bitcoin" OR "custody crypto" OR "bank deregulation"',
          mstr: '"MicroStrategy" OR "MSTR" OR "Michael Saylor"',
        };
        const q = encodeURIComponent(queries[topic] || queries.crypto_regulation);
        const r = await fetch(
          `https://gnews.io/api/v4/search?q=${q}&lang=en&max=10&apikey=${key}`
        );
        if (!r.ok) return res.status(r.status).json({ error: `GNews HTTP ${r.status}` });
        data = await r.json();
        break;
      }

      // ── Hash Ribbon via blockchain.info (no key needed)
      case 'hash': {
        const r = await fetch(
          'https://api.blockchain.info/charts/hash-rate?timespan=90days&format=json&cors=true'
        );
        data = await r.json();
        break;
      }

      // ── Miner economics: hashprice from mempool.space (free, no key)
      // Used to auto-detect miner capitulation (hashprice below breakeven)
      case 'miner': {
        // mempool.space provides mining difficulty + hashrate data
        // We combine with BTC price to estimate hashprice (USD/TH/day)
        const [diffRes, statsRes] = await Promise.all([
          fetch('https://mempool.space/api/v1/mining/hashrate/3m'),
          fetch('https://mempool.space/api/v1/mining/difficulty-adjustments?limit=1'),
        ]);
        const hashData = diffRes.ok ? await diffRes.json() : null;
        const diffData = statsRes.ok ? await statsRes.json() : null;
        data = { hashrate: hashData, difficulty: diffData };
        break;
      }

      // ── BGeometrics on-chain metrics (free, no key needed)
      // Provides real SOPR, NUPL, MVRV, Puell Multiple — replaces LTH proxy
      case 'bgeometrics': {
        const metric = params.metric || 'sopr';
        const base = 'https://bitcoin-data.com/v1';
        // Fetch latest value for the requested metric
        const endpoints = {
          sopr:   `${base}/sopr/1`,
          nupl:   `${base}/nupl/1`,
          mvrv:   `${base}/mvrv/1`,
          puell:  `${base}/puell-multiple/1`,
          'sth-sopr': `${base}/sth-sopr/1`,
          'sth-mvrv': `${base}/sth-mvrv/1`,
        };
        const url = endpoints[metric];
        if (!url) return res.status(400).json({ error: `Unknown metric: ${metric}` });
        const r = await fetch(url);
        if (!r.ok) return res.status(r.status).json({ error: `BGeometrics HTTP ${r.status}` });
        data = await r.json();
        break;
      }

      // ── BGeometrics batch — fetch all on-chain metrics in one proxy call
      case 'onchain': {
        const base = 'https://bitcoin-data.com/v1';
        const [soprR, nuplR, mvrvR, puellR, sthSoprR, sthMvrvR] = await Promise.allSettled([
          fetch(`${base}/sopr/1`).then(r => r.ok ? r.json() : null),
          fetch(`${base}/nupl/1`).then(r => r.ok ? r.json() : null),
          fetch(`${base}/mvrv/1`).then(r => r.ok ? r.json() : null),
          fetch(`${base}/puell-multiple/1`).then(r => r.ok ? r.json() : null),
          fetch(`${base}/sth-sopr/1`).then(r => r.ok ? r.json() : null),
          fetch(`${base}/sth-mvrv/1`).then(r => r.ok ? r.json() : null),
        ]);
        data = {
          sopr:     soprR.status === 'fulfilled' ? soprR.value : null,
          nupl:     nuplR.status === 'fulfilled' ? nuplR.value : null,
          mvrv:     mvrvR.status === 'fulfilled' ? mvrvR.value : null,
          puell:    puellR.status === 'fulfilled' ? puellR.value : null,
          sthSopr:  sthSoprR.status === 'fulfilled' ? sthSoprR.value : null,
          sthMvrv:  sthMvrvR.status === 'fulfilled' ? sthMvrvR.value : null,
        };
        break;
      }

      // ── Finnhub MSTR (free, 60 req/min — backup for Yahoo Finance)
      // Supports: quote (real-time price) and candles (1yr daily OHLCV for IV Rank + RVol)
      case 'finnhub': {
        const token = process.env.FINNHUB_KEY;
        if (!token) return res.status(503).json({ error: 'FINNHUB_KEY not configured' });
        const fType = params.type || 'quote';
        if (fType === 'candles') {
          // 1-year daily candles for IV Rank + RVol computation (backup for Yahoo history)
          const to = Math.floor(Date.now() / 1000);
          const from = to - 365 * 86400;
          const r = await fetch(`https://finnhub.io/api/v1/stock/candle?symbol=MSTR&resolution=D&from=${from}&to=${to}&token=${token}`);
          if (!r.ok) return res.status(r.status).json({ error: `Finnhub candles HTTP ${r.status}` });
          data = await r.json();
        } else {
          const r = await fetch(`https://finnhub.io/api/v1/quote?symbol=MSTR&token=${token}`);
          if (!r.ok) return res.status(r.status).json({ error: `Finnhub HTTP ${r.status}` });
          data = await r.json();
        }
        break;
      }

      // ── Alpha Vantage MSTR quote (free, 25 req/day — tertiary backup)
      case 'alphavantage': {
        const key = process.env.ALPHAVANTAGE_KEY;
        if (!key) return res.status(503).json({ error: 'ALPHAVANTAGE_KEY not configured' });
        const r = await fetch(`https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=MSTR&apikey=${key}`);
        if (!r.ok) return res.status(r.status).json({ error: `AlphaVantage HTTP ${r.status}` });
        data = await r.json();
        break;
      }

      // ── Tradier Sandbox — FREE options chain backup with full greeks
      // Free developer account at developer.tradier.com — delayed 15 min
      // Provides: options chain, IV, delta, gamma, theta, vega, rho
      // Key: TRADIER_SANDBOX_TOKEN in Vercel env vars
      case 'tradier_sandbox': {
        const token = process.env.TRADIER_SANDBOX_TOKEN;
        if (!token) return res.status(503).json({ error: 'TRADIER_SANDBOX_TOKEN not configured' });
        const tType = params.type || 'chain';
        const tHeaders = {
          'Authorization': `Bearer ${token}`,
          'Accept': 'application/json',
        };
        const tBase = 'https://sandbox.tradier.com/v1';

        if (tType === 'chain') {
          // Near-term options chain with greeks — closest monthly expiry
          const cacheKey = 'tradier_chain';
          const cached = getCached(cacheKey);
          if (cached) { data = cached; break; }
          // First get expirations to find nearest
          const expR = await fetch(`${tBase}/markets/options/expirations?symbol=MSTR&includeAllRoots=true`, { headers: tHeaders });
          if (!expR.ok) return res.status(expR.status).json({ error: `Tradier expirations HTTP ${expR.status}` });
          const expData = await expR.json();
          const expirations = expData?.expirations?.date || expData?.expirations?.expiration || [];
          if (!expirations.length) return res.status(404).json({ error: 'No expirations found' });
          // Pick closest expiry
          const nearest = Array.isArray(expirations) ? expirations[0] : expirations;
          const r = await fetch(`${tBase}/markets/options/chains?symbol=MSTR&expiration=${nearest}&greeks=true`, { headers: tHeaders });
          if (!r.ok) return res.status(r.status).json({ error: `Tradier chain HTTP ${r.status}` });
          data = await r.json();
          data._expiration = nearest;
          setCache(cacheKey, data);
        } else if (tType === 'leapchain') {
          // Dec 2028 LEAP chain with greeks
          const cacheKey = 'tradier_leapchain';
          const cached = getCached(cacheKey);
          if (cached) { data = cached; break; }
          // Get all expirations, find Dec 2028
          const expR = await fetch(`${tBase}/markets/options/expirations?symbol=MSTR&includeAllRoots=true`, { headers: tHeaders });
          if (!expR.ok) return res.status(expR.status).json({ error: `Tradier exp HTTP ${expR.status}` });
          const expData = await expR.json();
          const expirations = expData?.expirations?.date || expData?.expirations?.expiration || [];
          // Find Dec 2028 (or closest long-dated)
          const dec2028 = (Array.isArray(expirations) ? expirations : [expirations])
            .filter(d => d >= '2028-12-01' && d <= '2028-12-31');
          const leapExp = dec2028[0] || (Array.isArray(expirations) ? expirations : [expirations]).filter(d => d >= '2028-01-01').at(-1);
          if (!leapExp) return res.json({ error: 'Dec 2028 LEAP not listed yet', expirations });
          const r = await fetch(`${tBase}/markets/options/chains?symbol=MSTR&expiration=${leapExp}&greeks=true`, { headers: tHeaders });
          if (!r.ok) return res.status(r.status).json({ error: `Tradier LEAP chain HTTP ${r.status}` });
          data = await r.json();
          data._expiration = leapExp;
          setCache(cacheKey, data);
        } else if (tType === 'quote') {
          const r = await fetch(`${tBase}/markets/quotes?symbols=MSTR`, { headers: tHeaders });
          if (!r.ok) return res.status(r.status).json({ error: `Tradier quote HTTP ${r.status}` });
          data = await r.json();
        } else {
          return res.status(400).json({ error: `Unknown tradier type: ${tType}` });
        }
        break;
      }

      // ── MarketData.app — FREE tier options chain (100 req/day)
      // Free account at dashboard.marketdata.app — provides options chain with greeks
      // Key: MARKETDATA_TOKEN in Vercel env vars
      case 'marketdata': {
        const token = process.env.MARKETDATA_TOKEN;
        if (!token) return res.status(503).json({ error: 'MARKETDATA_TOKEN not configured' });
        const mdType = params.type || 'chain';
        const mdHeaders = {
          'Authorization': `Token ${token}`,
          'Accept': 'application/json',
        };
        const mdBase = 'https://api.marketdata.app/v1';

        if (mdType === 'chain') {
          const cacheKey = 'marketdata_chain';
          const cached = getCached(cacheKey);
          if (cached) { data = cached; break; }
          // Get options chain — nearest monthly expiry, all strikes near ATM
          const r = await fetch(`${mdBase}/options/chain/MSTR/?dte=7-45&strikeLimit=10`, { headers: mdHeaders });
          if (!r.ok) return res.status(r.status).json({ error: `MarketData chain HTTP ${r.status}` });
          data = await r.json();
          setCache(cacheKey, data);
        } else if (mdType === 'quote') {
          const r = await fetch(`${mdBase}/stocks/quotes/MSTR/`, { headers: mdHeaders });
          if (!r.ok) return res.status(r.status).json({ error: `MarketData quote HTTP ${r.status}` });
          data = await r.json();
        } else {
          return res.status(400).json({ error: `Unknown marketdata type: ${mdType}` });
        }
        break;
      }

      // ── Blockchain.info additional charts (free, no key)
      // Mining difficulty + revenue for miner economics
      case 'blockchain': {
        const chart = params.chart || 'difficulty';
        const allowed = ['difficulty', 'miners-revenue', 'hash-rate', 'cost-per-transaction'];
        if (!allowed.includes(chart)) return res.status(400).json({ error: `Unknown chart: ${chart}` });
        const r = await fetch(
          `https://api.blockchain.info/charts/${chart}?timespan=90days&format=json&cors=true`
        );
        if (!r.ok) return res.status(r.status).json({ error: `blockchain.info HTTP ${r.status}` });
        data = await r.json();
        break;
      }

      // ── BTC ETF Flows via SoSoValue
      case 'sosovalue': {
        const key = process.env.SOSOVALUE_KEY;
        if (!key) return res.json({ ok: false, reason: 'SOSOVALUE_KEY not configured' });
        const r = await fetch(
          'https://api.sosovalue.com/v1/etf/btc-spot-etf-flow/list?limit=10',
          { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' } }
        );
        if (!r.ok) return res.json({ ok: false, reason: `HTTP ${r.status}` });
        data = await r.json();
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown source: ${source}` });
    }

    res.status(200).json(data);

  } catch (err) {
    console.error(`[proxy] error source=${source} endpoint=${endpoint}:`, err.message);
    res.status(500).json({ error: err.message });
  }
}
