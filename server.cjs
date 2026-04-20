'use strict';

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const https = require('https');
const crypto = require('crypto');
const QRCode = require('qrcode');
const rateLimit = require('express-rate-limit');

const app = express();
app.use(express.json());

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT || 3002;
const SBP_KEY    = process.env.SATONERO_SBP_KEY || '';
const SBP_SECRET = process.env.SATONERO_SBP_SECRET || ''; // za HMAC webhook verifikaciju
const ADMIN_KEY  = process.env.SATONERO_ADMIN_KEY || 'satonero_admin';
const BASE_URL   = (process.env.BASE_URL || ('http://localhost:' + PORT)).replace(/\/$/, '');
const DB_URL     = process.env.DATABASE_URL;

// ─── DATABASE ─────────────────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: DB_URL,
  ssl: DB_URL ? { rejectUnauthorized: false } : false
});

// ─── HELPERS ──────────────────────────────────────────────────────────────────
function uid()  { return crypto.randomBytes(8).toString('hex'); }
function now()  { return Date.now(); }
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}

function calcComm(sats, type) {
  if (sats < 100) return 1;
  const rates = { crypto:0.03, token:0.03, voucher:0.02, giftcard:0.02, lending:0.01, task:0.02, prediction:0.03 };
  return Math.max(Math.floor(sats * (rates[type] || 0.03)), 1);
}

// ─── RATE LIMITING ────────────────────────────────────────────────────────────
const apiLimiter = rateLimit({
  windowMs: 60 * 1000,  // 1 minuta
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Previše zahtjeva, pokušaj za minut.' }
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minuta
  max: 20,
  message: { error: 'Previše pokušaja, pokušaj za 15 minuta.' }
});

app.use('/api/', apiLimiter);
app.use('/api/admin/', authLimiter);

// ─── ADMIN AUTH MIDDLEWARE ────────────────────────────────────────────────────
function requireAdmin(req, res, next) {
  const key = req.headers['x-admin-key'] || req.body?.adminKey;
  if (!key || key !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  next();
}

// ─── WEBHOOK HMAC VERIFIKACIJA ────────────────────────────────────────────────
function verifyWebhook(req, res, next) {
  // Ako SBP_SECRET nije postavljen, preskoči (za lokalni dev)
  if (!SBP_SECRET) return next();
  const sig = req.headers['x-sbp-signature'] || '';
  const body = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha256', SBP_SECRET).update(body).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected))) {
    return res.status(401).json({ error: 'Invalid webhook signature' });
  }
  next();
}

// ─── PRICE CACHE ──────────────────────────────────────────────────────────────
const priceCache = new Map(); // asset → { price, ts }
const PRICE_TTL = 60_000;     // 60 sekundi

async function getPrice(asset) {
  const MAP = {
    BTC:'bitcoin', ETH:'ethereum', LTC:'litecoin',
    BNB:'binancecoin', USDT:'tether', USDC:'usd-coin',
    TRX:'tron', SOL:'solana'
  };
  const id = MAP[asset.toUpperCase()];
  if (!id) return null;

  const cached = priceCache.get(asset);
  if (cached && now() - cached.ts < PRICE_TTL) return cached.price;

  return new Promise(resolve => {
    https.get('https://api.coingecko.com/api/v3/simple/price?ids=' + id + '&vs_currencies=usd', res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => {
        try {
          const price = JSON.parse(d)[id]?.usd || null;
          if (price) priceCache.set(asset, { price, ts: now() });
          resolve(price);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

// ─── SBP API ──────────────────────────────────────────────────────────────────
function sbpRequest(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.swiss-bitcoin-pay.ch',
      path, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'api-key': SBP_KEY,
        'Content-Length': Buffer.byteLength(data)
      }
    }, res => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

async function createInvoice(sats, desc, webhookUrl) {
  return sbpRequest('/charge', { amount: sats, unit: 'sat', description: desc, webhook: webhookUrl, delay: 900 });
}

async function sendPayout(address, sats) {
  return sbpRequest('/payout', { amount: sats, unit: 'sat', address });
}

async function makeInvoiceResponse(sats, desc, webhookUrl) {
  const inv = await createInvoice(sats, desc, webhookUrl);
  const pr  = inv.payment_request || inv.pr || null;
  const qr  = pr ? await QRCode.toDataURL('lightning:' + pr) : null;
  return { invoiceId: inv.id, paymentRequest: pr, qr, checkoutUrl: inv.checkout_url || null };
}

// ─── USER HELPERS ─────────────────────────────────────────────────────────────
async function upsertUser(id, email) {
  await pool.query(
    `INSERT INTO sato_users (id, email, balance_sats, rating, total_trades, trusted, created_at)
     VALUES ($1,$2,0,5.0,0,false,$3)
     ON CONFLICT (id) DO UPDATE SET email = COALESCE($2, sato_users.email)`,
    [id, email || null, now()]
  );
}

// ─── RELEASE SWAP (sa DB transakcijom) ───────────────────────────────────────
async function releaseSwap(txId, client) {
  const c = client || await pool.connect();
  const ownClient = !client;
  try {
    if (ownClient) await c.query('BEGIN');

    const { rows } = await c.query(
      "SELECT * FROM sato_transactions WHERE id=$1 AND status IN ('paid','manual') FOR UPDATE",
      [txId]
    );
    if (!rows.length) {
      if (ownClient) await c.query('ROLLBACK');
      return false;
    }
    const tx = rows[0];
    const payout = Math.max(0, Math.floor(Number(tx.offer_amount)) - Number(tx.commission_sats));

    await c.query(
      'UPDATE sato_transactions SET status=$1, released_at=$2 WHERE id=$3',
      ['released', now(), txId]
    );
    await c.query(
      'UPDATE sato_users SET balance_sats=balance_sats+$1, total_trades=total_trades+1 WHERE id=$2',
      [payout, tx.seller_id]
    );
    await c.query(
      'UPDATE sato_users SET total_trades=total_trades+1 WHERE id=$1',
      [tx.buyer_id]
    );
    await c.query(
      'UPDATE sato_users SET trusted=true WHERE (id=$1 OR id=$2) AND total_trades>=5',
      [tx.seller_id, tx.buyer_id]
    );

    if (ownClient) await c.query('COMMIT');
    return true;
  } catch(e) {
    if (ownClient) await c.query('ROLLBACK');
    throw e;
  } finally {
    if (ownClient) c.release();
  }
}

// ─── DB INIT ──────────────────────────────────────────────────────────────────
async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_assets (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      symbol TEXT, contract_address TEXT, decimals INT DEFAULT 0,
      network TEXT, active BOOLEAN DEFAULT true, created_at BIGINT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_users (
      id TEXT PRIMARY KEY, email TEXT,
      balance_sats BIGINT DEFAULT 0, rating NUMERIC DEFAULT 5.0,
      total_trades INT DEFAULT 0, trusted BOOLEAN DEFAULT false, created_at BIGINT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_listings (
      id TEXT PRIMARY KEY, seller_id TEXT NOT NULL,
      offer_asset TEXT NOT NULL, offer_amount NUMERIC NOT NULL,
      want_asset TEXT NOT NULL, want_amount NUMERIC NOT NULL,
      description TEXT, status TEXT DEFAULT 'active', created_at BIGINT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_transactions (
      id TEXT PRIMARY KEY, listing_id TEXT, buyer_id TEXT, seller_id TEXT,
      offer_asset TEXT, offer_amount NUMERIC, want_asset TEXT, want_amount NUMERIC,
      commission_sats BIGINT DEFAULT 0, invoice_id TEXT, payment_request TEXT,
      status TEXT DEFAULT 'pending', dispute_reason TEXT,
      created_at BIGINT, paid_at BIGINT, released_at BIGINT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_messages (
      id TEXT PRIMARY KEY, ref_id TEXT NOT NULL, ref_type TEXT NOT NULL,
      sender_id TEXT NOT NULL, content TEXT NOT NULL, created_at BIGINT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_ratings (
      id TEXT PRIMARY KEY, tx_id TEXT NOT NULL,
      from_user TEXT NOT NULL, to_user TEXT NOT NULL,
      score INT NOT NULL, created_at BIGINT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_loans (
      id TEXT PRIMARY KEY, lender_id TEXT NOT NULL, borrower_id TEXT,
      amount_sats BIGINT NOT NULL, interest_sats BIGINT NOT NULL,
      duration_hours INT NOT NULL, collateral TEXT,
      status TEXT DEFAULT 'open',
      invoice_id TEXT, payment_request TEXT,
      repay_invoice_id TEXT, repay_payment_request TEXT,
      created_at BIGINT, funded_at BIGINT, due_at BIGINT, repaid_at BIGINT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_tasks (
      id TEXT PRIMARY KEY, poster_id TEXT NOT NULL, worker_id TEXT,
      title TEXT NOT NULL, description TEXT NOT NULL,
      reward_sats BIGINT NOT NULL, proof_required TEXT,
      status TEXT DEFAULT 'open',
      invoice_id TEXT, payment_request TEXT, proof_submission TEXT,
      created_at BIGINT, taken_at BIGINT, completed_at BIGINT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_predictions (
      id TEXT PRIMARY KEY, creator_id TEXT NOT NULL,
      asset TEXT NOT NULL, target_price NUMERIC NOT NULL,
      direction TEXT NOT NULL, resolve_at BIGINT NOT NULL,
      stake_sats BIGINT NOT NULL, creator_side TEXT NOT NULL,
      challenger_id TEXT, challenger_side TEXT,
      status TEXT DEFAULT 'open', winner_id TEXT,
      commission_sats BIGINT DEFAULT 0,
      invoice_id TEXT, payment_request TEXT,
      challenger_invoice_id TEXT, challenger_payment_request TEXT,
      created_at BIGINT, resolved_at BIGINT
    )`);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS sato_data_listings (
      id TEXT PRIMARY KEY, seller_id TEXT NOT NULL,
      title TEXT NOT NULL, description TEXT NOT NULL,
      type TEXT NOT NULL, price_sats BIGINT NOT NULL,
      duration_hours INT, status TEXT DEFAULT 'active', created_at BIGINT
    )`);

  // Seed assets
  const assets = [
    ['sats','Satoshi (Lightning)','crypto','SATS',null,0,null],
    ['btc','Bitcoin','crypto','BTC',null,8,null],
    ['ltc','Litecoin','crypto','LTC',null,8,null],
    ['eth','Ethereum','crypto','ETH',null,18,'ETH'],
    ['usdt','Tether USDT','crypto','USDT',null,6,'ETH/TRX'],
    ['usdc','USD Coin','crypto','USDC',null,6,'ETH'],
    ['bnb','BNB','crypto','BNB',null,18,'BSC'],
    ['trx','TRON','crypto','TRX',null,6,'TRX'],
    ['paysafe','Paysafecard','voucher',null,null,0,null],
    ['xbon','xBon','voucher',null,null,0,null],
    ['luxon','Luxon Pay','voucher',null,null,0,null],
    ['aircash','Aircash','voucher',null,null,0,null],
    ['steam','Steam Gift Card','giftcard',null,null,0,null],
    ['amazon','Amazon Gift Card','giftcard',null,null,0,null],
    ['google','Google Play Card','giftcard',null,null,0,null],
    ['itunes','iTunes Gift Card','giftcard',null,null,0,null],
  ];
  for (const [id,name,type,symbol,contract,decimals,network] of assets) {
    await pool.query(
      `INSERT INTO sato_assets (id,name,type,symbol,contract_address,decimals,network,active,created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) ON CONFLICT (id) DO NOTHING`,
      [id,name,type,symbol,contract,decimals,network,now()]
    );
  }
  console.log('✅ SATONERO DB initialized.');
}

// ─── AUTO TIMERS ──────────────────────────────────────────────────────────────
setInterval(async () => {
  try {
    // Auto-release swaps nakon 15 min
    const { rows: txs } = await pool.query(
      "SELECT id FROM sato_transactions WHERE status='paid' AND paid_at < $1",
      [now() - 900_000]
    );
    for (const { id } of txs) {
      try { await releaseSwap(id); } catch(e) { console.error('releaseSwap err:', e.message); }
    }

    // Auto-default expired loans
    await pool.query(
      "UPDATE sato_loans SET status='defaulted' WHERE status='active' AND due_at < $1",
      [now()]
    );

    // Auto-resolve predictions
    const { rows: preds } = await pool.query(
      "SELECT * FROM sato_predictions WHERE status='active' AND resolve_at <= $1",
      [now()]
    );
    for (const p of preds) {
      try {
        const price = await getPrice(p.asset);
        if (!price) continue;
        const above     = price >= Number(p.target_price);
        const yesWins   = p.direction === 'above' ? above : !above;
        const creatorWins = (p.creator_side === 'yes') === yesWins;
        const winner    = creatorWins ? p.creator_id : p.challenger_id;
        const total     = Number(p.stake_sats) * 2;
        const comm      = calcComm(total, 'prediction');
        await pool.query(
          'UPDATE sato_predictions SET status=$1,winner_id=$2,commission_sats=$3,resolved_at=$4 WHERE id=$5',
          ['resolved', winner, comm, now(), p.id]
        );
        if (winner) {
          await pool.query(
            'UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2',
            [total - comm, winner]
          );
        }
      } catch(e) { console.error('Prediction resolve err:', e.message); }
    }
  } catch(e) { console.error('Timer err:', e.message); }
}, 60_000);

// ═══════════════════════════════════════════════════════════════════════════════
//  ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

// ─── ASSETS ───────────────────────────────────────────────────────────────────
app.get('/api/assets', async (req, res, next) => {
  try {
    const { rows } = await pool.query("SELECT * FROM sato_assets WHERE active=true ORDER BY type,name");
    res.json(rows);
  } catch(e) { next(e); }
});

app.post('/api/admin/assets', requireAdmin, async (req, res, next) => {
  try {
    const { name, type, symbol, contractAddress, decimals, network } = req.body;
    if (!name || !type) return res.status(400).json({ error: 'name i type su obavezni' });
    const id = uid();
    await pool.query(
      'INSERT INTO sato_assets (id,name,type,symbol,contract_address,decimals,network,active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)',
      [id, name, type, symbol||null, contractAddress||null, decimals||0, network||null, now()]
    );
    res.json({ ok: true, id });
  } catch(e) { next(e); }
});

app.patch('/api/admin/assets/:id', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('UPDATE sato_assets SET active=$1 WHERE id=$2', [!!req.body.active, req.params.id]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

app.delete('/api/admin/assets/:id', requireAdmin, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM sato_assets WHERE id=$1', [req.params.id]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// ─── USERS ────────────────────────────────────────────────────────────────────
app.post('/api/user', async (req, res, next) => {
  try {
    const { userId, email } = req.body;
    if (!userId) return res.status(400).json({ error: 'userId obavezan' });
    await upsertUser(userId, email);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

app.get('/api/user/:id', async (req, res, next) => {
  try {
    await upsertUser(req.params.id, null);
    const { rows } = await pool.query('SELECT * FROM sato_users WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Korisnik nije pronađen' });
    const { rows: listings } = await pool.query(
      "SELECT * FROM sato_listings WHERE seller_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 5",
      [req.params.id]
    );
    const { rows: ratings } = await pool.query(
      'SELECT * FROM sato_ratings WHERE to_user=$1 ORDER BY created_at DESC LIMIT 10',
      [req.params.id]
    );
    res.json({ ...rows[0], listings, ratings });
  } catch(e) { next(e); }
});

app.post('/api/withdraw', async (req, res, next) => {
  const client = await pool.connect();
  try {
    const { userId, lightningAddress, amountSats } = req.body;
    if (!userId || !lightningAddress || !amountSats) return res.status(400).json({ error: 'Nedostaju polja' });

    await client.query('BEGIN');
    const { rows } = await client.query('SELECT * FROM sato_users WHERE id=$1 FOR UPDATE', [userId]);
    if (!rows.length) { await client.query('ROLLBACK'); return res.status(404).json({ error: 'Korisnik nije pronađen' }); }
    if (rows[0].balance_sats < amountSats) { await client.query('ROLLBACK'); return res.status(400).json({ error: 'Nedovoljno stanje' }); }

    await client.query('UPDATE sato_users SET balance_sats=balance_sats-$1 WHERE id=$2', [amountSats, userId]);
    await client.query('COMMIT');

    const result = await sendPayout(lightningAddress, amountSats);
    if (result.error) {
      // Vrati sats ako payout nije prošao
      await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [amountSats, userId]);
      return res.status(400).json({ error: result.error });
    }
    res.json({ ok: true, sent: amountSats });
  } catch(e) { await client.query('ROLLBACK'); next(e); }
  finally { client.release(); }
});

// ─── DEPOSIT ──────────────────────────────────────────────────────────────────
app.post('/api/deposit', async (req, res, next) => {
  try {
    const { userId, amountSats } = req.body;
    if (!userId || !amountSats) return res.status(400).json({ error: 'Nedostaju polja' });
    await upsertUser(userId, null);
    const { invoiceId, paymentRequest, qr, checkoutUrl } = await makeInvoiceResponse(
      amountSats,
      'SATONERO deposit - ' + userId,
      BASE_URL + '/api/webhook/deposit/' + userId
      // Iznos čitamo iz SBP payloada, ne iz URL-a!
    );
    // Čuvamo invoiceId da znamo koliko je uplata
    await pool.query(
      "INSERT INTO sato_transactions (id,buyer_id,offer_asset,offer_amount,want_asset,want_amount,invoice_id,payment_request,status,created_at) VALUES ($1,$2,'sats',$3,'sats',$3,$4,$5,'deposit_pending',$6)",
      [invoiceId, userId, amountSats, invoiceId, paymentRequest, now()]
    );
    res.json({ invoiceId, paymentRequest, qr, checkoutUrl });
  } catch(e) { next(e); }
});

// Webhook od SBP — iznos dolazi iz SBP payloada, ne iz URL-a
app.post('/api/webhook/deposit/:userId', verifyWebhook, async (req, res, next) => {
  try {
    const { userId } = req.params;
    // SBP šalje amount u payloadu
    const amount = req.body.amount || req.body.sats || req.body.value || 0;
    if (!amount) return res.json({ ok: true }); // ignoriši prazne
    await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [Number(amount), userId]);
    res.json({ ok: true });
  } catch(e) { next(e); }
});

// ─── SWAP LISTINGS ────────────────────────────────────────────────────────────
app.get('/api/listings', async (req, res, next) => {
  try {
    const { type } = req.query;
    let q = `SELECT l.*, a1.name AS offer_name, a1.type AS offer_type,
             a2.name AS want_name, a2.type AS want_type,
             u.rating, u.trusted
             FROM sato_listings l
             LEFT JOIN sato_assets a1 ON l.offer_asset=a1.id
             LEFT JOIN sato_assets a2 ON l.want_asset=a2.id
             LEFT JOIN sato_users u ON l.seller_id=u.id
             WHERE l.status='active'`;
    const params = [];
    if (type && type !== 'all') { q += ' AND (a1.type=$1 OR a2.type=$1)'; params.push(type); }
  