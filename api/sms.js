// api/sms.js — Multi-channel message delivery with automatic failover
// Cascade: Twilio SMS → Amazon SNS SMS → Telegram → Email-to-SMS
// If one channel fails or runs out of free credits, falls through to the next.
// All channels configured via Vercel env vars — only set what you have.
//
// ENV VARS (set whichever you have — at least one required):
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER
//   AWS_SNS_ACCESS_KEY, AWS_SNS_SECRET_KEY, AWS_SNS_REGION (default us-east-1)
//   TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID (or per-user via request body)
//   SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM

export const config = { runtime: 'nodejs' };

// ── Phone number normalization (E.164)
function normalizePhone(raw) {
  let phone = raw.replace(/[\s\-\(\)\.]/g, '');
  if (!phone.startsWith('+')) {
    phone = phone.startsWith('1') ? `+${phone}` : `+1${phone}`;
  }
  const digits = phone.replace('+', '');
  if (digits.length < 10 || digits.length > 15 || !/^\d+$/.test(digits)) {
    return null;
  }
  return phone;
}

// ── US carrier email-to-SMS gateways
const CARRIER_GATEWAYS = {
  verizon:  'vtext.com',
  att:      'txt.att.net',
  tmobile:  'tmomail.net',
  sprint:   'messaging.sprintpcs.com',
  uscellular: 'email.uscc.net',
  boost:    'sms.myboostmobile.com',
  cricket:  'sms.cricketwireless.net',
  metro:    'mymetropcs.com',
  mint:     'tmomail.net', // Mint runs on T-Mobile
  visible:  'vtext.com',   // Visible runs on Verizon
  fi:       'msg.fi.google.com', // Google Fi
};

// ══════════════════════════════════════════════════════════════════════════════
// CHANNEL 1: Twilio SMS (primary — $15.50 free trial, then ~$0.008/SMS)
// ══════════════════════════════════════════════════════════════════════════════
async function sendTwilio(phone, body) {
  const sid   = process.env.TWILIO_ACCOUNT_SID;
  const token = process.env.TWILIO_AUTH_TOKEN;
  const from  = process.env.TWILIO_FROM_NUMBER;
  if (!sid || !token || !from) return { ok: false, error: 'Twilio not configured', skip: true };

  try {
    const url = `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`;
    const auth = Buffer.from(`${sid}:${token}`).toString('base64');
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ To: phone, From: from, Body: body }).toString(),
    });
    const data = await r.json();
    if (!r.ok) {
      // Error code 20003 = auth failure (expired trial), 21610 = unsubscribed, 21211 = invalid number
      const exhausted = data.code === 20003 || data.code === 20008 ||
                        (data.message || '').toLowerCase().includes('trial');
      return { ok: false, error: data.message || `HTTP ${r.status}`, code: data.code, exhausted };
    }
    return { ok: true, channel: 'twilio', sid: data.sid, status: data.status };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CHANNEL 2: Amazon SNS SMS (100 free SMS/month forever on AWS free tier)
// ══════════════════════════════════════════════════════════════════════════════
async function sendSNS(phone, body) {
  const accessKey = process.env.AWS_SNS_ACCESS_KEY;
  const secretKey = process.env.AWS_SNS_SECRET_KEY;
  const region    = process.env.AWS_SNS_REGION || 'us-east-1';
  if (!accessKey || !secretKey) return { ok: false, error: 'AWS SNS not configured', skip: true };

  try {
    // AWS Signature Version 4 for SNS
    const host = `sns.${region}.amazonaws.com`;
    const endpoint = `https://${host}/`;
    const params = new URLSearchParams({
      Action: 'Publish',
      PhoneNumber: phone,
      Message: body.slice(0, 140), // SNS SMS limit per segment
      'MessageAttributes.entry.1.Name': 'AWS.SNS.SMS.SenderID',
      'MessageAttributes.entry.1.Value.DataType': 'String',
      'MessageAttributes.entry.1.Value.StringValue': 'FOLATAC',
      'MessageAttributes.entry.2.Name': 'AWS.SNS.SMS.SMSType',
      'MessageAttributes.entry.2.Value.DataType': 'String',
      'MessageAttributes.entry.2.Value.StringValue': 'Transactional',
      Version: '2010-03-31',
    });

    // AWS SigV4 signing
    const now = new Date();
    const dateStamp = now.toISOString().replace(/[-:]/g, '').split('.')[0] + 'Z';
    const dateOnly = dateStamp.slice(0, 8);
    const credentialScope = `${dateOnly}/${region}/sns/aws4_request`;
    const canonical = [
      'POST', '/', '', `host:${host}`, `x-amz-date:${dateStamp}`, '',
      'host;x-amz-date', await sha256Hex(params.toString()),
    ].join('\n');
    const stringToSign = ['AWS4-HMAC-SHA256', dateStamp, credentialScope, await sha256Hex(canonical)].join('\n');

    const kDate    = await hmacSha256(`AWS4${secretKey}`, dateOnly);
    const kRegion  = await hmacSha256(kDate, region);
    const kService = await hmacSha256(kRegion, 'sns');
    const kSigning = await hmacSha256(kService, 'aws4_request');
    const signature = await hmacSha256Hex(kSigning, stringToSign);

    const authHeader = `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=host;x-amz-date, Signature=${signature}`;

    const r = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Host': host,
        'X-Amz-Date': dateStamp,
        'Authorization': authHeader,
      },
      body: params.toString(),
    });

    const text = await r.text();
    if (!r.ok) {
      const exhausted = text.includes('Monthly SMS spend limit') || text.includes('throttl');
      return { ok: false, error: `SNS HTTP ${r.status}`, exhausted, detail: text.slice(0, 200) };
    }
    // Extract MessageId from XML
    const msgId = text.match(/<MessageId>([^<]+)<\/MessageId>/)?.[1] || 'sent';
    return { ok: true, channel: 'sns', messageId: msgId };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// AWS SigV4 helpers (Node.js crypto)
async function sha256Hex(data) {
  const { createHash } = await import('crypto');
  return createHash('sha256').update(data).digest('hex');
}
async function hmacSha256(key, data) {
  const { createHmac } = await import('crypto');
  const k = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  return createHmac('sha256', k).update(data).digest();
}
async function hmacSha256Hex(key, data) {
  const { createHmac } = await import('crypto');
  const k = typeof key === 'string' ? Buffer.from(key, 'utf8') : key;
  return createHmac('sha256', k).update(data).digest('hex');
}

// ══════════════════════════════════════════════════════════════════════════════
// CHANNEL 3: Telegram Bot (completely free, unlimited, instant push notifications)
// ══════════════════════════════════════════════════════════════════════════════
async function sendTelegram(body, chatId) {
  const botToken = process.env.TELEGRAM_BOT_TOKEN;
  const defaultChat = chatId || process.env.TELEGRAM_CHAT_ID;
  if (!botToken || !defaultChat) return { ok: false, error: 'Telegram not configured', skip: true };

  try {
    const r = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: defaultChat,
        text: body.slice(0, 4096), // Telegram limit
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      }),
    });
    const data = await r.json();
    if (!data.ok) {
      return { ok: false, error: data.description || 'Telegram error' };
    }
    return { ok: true, channel: 'telegram', messageId: data.result?.message_id };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// CHANNEL 4: Email-to-SMS via carrier gateway (completely free, no API needed)
// Sends email to carrier's SMS gateway (e.g. 5551234567@vtext.com for Verizon)
// Requires SMTP credentials (Gmail app password works, or any SMTP provider)
// ══════════════════════════════════════════════════════════════════════════════
async function sendEmailSMS(phone, body, carrier) {
  const smtpHost = process.env.SMTP_HOST;
  const smtpPort = process.env.SMTP_PORT || '587';
  const smtpUser = process.env.SMTP_USER;
  const smtpPass = process.env.SMTP_PASS;
  const smtpFrom = process.env.SMTP_FROM || smtpUser;
  if (!smtpHost || !smtpUser || !smtpPass) return { ok: false, error: 'SMTP not configured', skip: true };
  if (!carrier) return { ok: false, error: 'Carrier not set for email-to-SMS', skip: true };

  const gateway = CARRIER_GATEWAYS[carrier.toLowerCase()];
  if (!gateway) return { ok: false, error: `Unknown carrier: ${carrier}. Supported: ${Object.keys(CARRIER_GATEWAYS).join(', ')}` };

  // Strip country code for email gateway (just 10-digit US number)
  const digits = phone.replace(/\D/g, '');
  const num10 = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  const toEmail = `${num10}@${gateway}`;

  try {
    // Minimal SMTP via raw TCP — no npm package needed
    // We use a simple HTTP-based email API as fallback (Vercel doesn't support raw TCP)
    // Instead, use fetch to a free transactional email API

    // Option A: If SMTP_HOST is a REST API endpoint (e.g., Brevo, Mailgun HTTP API)
    if (smtpHost.includes('api.') || smtpHost.includes('http')) {
      // Brevo / Mailgun / SendGrid HTTP API
      const r = await fetch(smtpHost, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${smtpPass}`,
          'api-key': smtpPass,
        },
        body: JSON.stringify({
          sender: { email: smtpFrom, name: 'FOLATAC' },
          to: [{ email: toEmail }],
          subject: 'FOLATAC Alert',
          textContent: body.slice(0, 160), // SMS length
        }),
      });
      if (!r.ok) return { ok: false, error: `Email API HTTP ${r.status}` };
      return { ok: true, channel: 'email-sms', to: toEmail, gateway };
    }

    // Option B: Use nodemailer-compatible SMTP (works in Vercel Node.js runtime)
    const { createTransport } = await import('nodemailer');
    const transport = createTransport({
      host: smtpHost,
      port: parseInt(smtpPort),
      secure: smtpPort === '465',
      auth: { user: smtpUser, pass: smtpPass },
    });

    await transport.sendMail({
      from: `FOLATAC <${smtpFrom}>`,
      to: toEmail,
      subject: '',  // Empty subject for SMS gateway — message goes in body
      text: body.slice(0, 160),
    });

    return { ok: true, channel: 'email-sms', to: toEmail, gateway };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER — cascading delivery with automatic failover
// ══════════════════════════════════════════════════════════════════════════════
export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { to, message, carrier, telegramChatId, channels } = req.body;

  if (!message) {
    return res.status(400).json({ error: 'Missing "message" field' });
  }

  // If no phone number, can still send via Telegram
  const phone = to ? normalizePhone(to) : null;
  if (to && !phone) {
    return res.status(400).json({ error: `Invalid phone number: ${to}` });
  }

  const body = message.slice(0, 1600);
  const attempts = [];
  let delivered = false;

  // Determine which channels to try (default: all configured, in cascade order)
  const tryChannels = channels || ['twilio', 'sns', 'telegram', 'email-sms'];

  for (const ch of tryChannels) {
    if (delivered) break;

    let result;
    switch (ch) {
      case 'twilio':
        if (!phone) { result = { ok: false, error: 'No phone number', skip: true }; break; }
        result = await sendTwilio(phone, body);
        break;
      case 'sns':
        if (!phone) { result = { ok: false, error: 'No phone number', skip: true }; break; }
        result = await sendSNS(phone, body);
        break;
      case 'telegram':
        result = await sendTelegram(body, telegramChatId);
        break;
      case 'email-sms':
        if (!phone) { result = { ok: false, error: 'No phone number', skip: true }; break; }
        result = await sendEmailSMS(phone, body, carrier);
        break;
      default:
        result = { ok: false, error: `Unknown channel: ${ch}`, skip: true };
    }

    attempts.push({ channel: ch, ...result });

    if (result.ok) {
      delivered = true;
    } else if (result.skip) {
      // Channel not configured — silently try next
      continue;
    } else if (result.exhausted) {
      // Channel ran out of free credits — log and try next
      console.warn(`[sms] ${ch} exhausted/throttled, falling through to next channel`);
      continue;
    } else {
      // Channel failed for other reason — try next
      console.warn(`[sms] ${ch} failed: ${result.error}, trying next channel`);
      continue;
    }
  }

  if (delivered) {
    const winner = attempts.find(a => a.ok);
    return res.json({
      ok: true,
      channel: winner.channel,
      attempts,
    });
  } else {
    return res.status(502).json({
      ok: false,
      error: 'All delivery channels failed',
      attempts,
    });
  }
}
