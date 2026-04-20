'use strict';
const express = require('express');
const { Pool } = require('pg');
const https = require('https');
const crypto = require('crypto');
const QRCode = require('qrcode');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3002;
const SBP_KEY = process.env.SATONERO_SBP_KEY || '';
const ADMIN_KEY = process.env.SATONERO_ADMIN_KEY || 'satonero_admin';
const ADMIN_EMAIL = process.env.SATONERO_ADMIN_EMAIL || 'telgram@tutamail.com';
const BASE_URL = (process.env.BASE_URL || ('http://localhost:' + PORT)).replace(/\/$/, '');
const DB_URL = process.env.DATABASE_URL;

const pool = new Pool({ connectionString: DB_URL, ssl: DB_URL ? { rejectUnauthorized: false } : false });

function uid() { return crypto.randomBytes(8).toString('hex'); }
function now() { return Date.now(); }
function esc(v) { return String(v == null ? '' : v).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }

function calcComm(sats, type) {
  const r = { crypto: 0.03, token: 0.03, voucher: 0.02, giftcard: 0.02, lending: 0.01, task: 0.02, prediction: 0.03 };
  if (sats < 100) return 1;
  return Math.max(Math.floor(sats * (r[type] || 0.03)), 1);
}

function sbpRequest(path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = https.request({
      hostname: 'api.swiss-bitcoin-pay.ch', path, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'api-key': SBP_KEY, 'Content-Length': Buffer.byteLength(data) }
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => { try { resolve(JSON.parse(d)); } catch(e) { reject(e); } }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

async function createInvoice(sats, desc, webhookUrl) {
  return sbpRequest('/charge', { amount: sats, unit: 'sat', description: desc, webhook: webhookUrl, delay: 900 });
}

async function sendPayout(address, sats) {
  return sbpRequest('/payout', { amount: sats, unit: 'sat', address });
}

async function getPrice(asset) {
  const MAP = { BTC:'bitcoin', ETH:'ethereum', LTC:'litecoin', BNB:'binancecoin', USDT:'tether', USDC:'usd-coin', TRX:'tron', SOL:'solana' };
  const id = MAP[asset.toUpperCase()];
  if (!id) return null;
  return new Promise(resolve => {
    https.get('https://api.coingecko.com/api/v3/simple/price?ids=' + id + '&vs_currencies=usd', res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)[id]?.usd || null); } catch { resolve(null); } });
    }).on('error', () => resolve(null));
  });
}

async function upsertUser(id, email) {
  await pool.query(
    'INSERT INTO sato_users (id, email, balance_sats, rating, total_trades, trusted, created_at) VALUES ($1,$2,0,5.0,0,false,$3) ON CONFLICT (id) DO UPDATE SET email = COALESCE($2, sato_users.email)',
    [id, email || null, now()]
  );
}

async function releaseSwap(txId) {
  const { rows } = await pool.query('SELECT * FROM sato_transactions WHERE id=$1', [txId]);
  if (!rows.length || rows[0].status !== 'paid') return;
  const tx = rows[0];
  const payout = Math.max(0, Math.floor(Number(tx.offer_amount)) - Number(tx.commission_sats));
  await pool.query('UPDATE sato_transactions SET status=$1, released_at=$2 WHERE id=$3', ['released', now(), txId]);
  await pool.query('UPDATE sato_users SET balance_sats = balance_sats + $1, total_trades = total_trades + 1 WHERE id=$2', [payout, tx.seller_id]);
  await pool.query('UPDATE sato_users SET total_trades = total_trades + 1 WHERE id=$1', [tx.buyer_id]);
  await pool.query('UPDATE sato_users SET trusted=true WHERE (id=$1 OR id=$2) AND total_trades >= 5', [tx.seller_id, tx.buyer_id]);
}

// --- DB INIT ---
async function initDb() {
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_assets (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, symbol TEXT, contract_address TEXT, decimals INT DEFAULT 0, network TEXT, active BOOLEAN DEFAULT true, created_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_users (id TEXT PRIMARY KEY, email TEXT, balance_sats BIGINT DEFAULT 0, rating NUMERIC DEFAULT 5.0, total_trades INT DEFAULT 0, trusted BOOLEAN DEFAULT false, created_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_listings (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, offer_asset TEXT NOT NULL, offer_amount NUMERIC NOT NULL, want_asset TEXT NOT NULL, want_amount NUMERIC NOT NULL, description TEXT, status TEXT DEFAULT 'active', created_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_transactions (id TEXT PRIMARY KEY, listing_id TEXT, buyer_id TEXT, seller_id TEXT, offer_asset TEXT, offer_amount NUMERIC, want_asset TEXT, want_amount NUMERIC, commission_sats BIGINT DEFAULT 0, invoice_id TEXT, payment_request TEXT, status TEXT DEFAULT 'pending', dispute_reason TEXT, created_at BIGINT, paid_at BIGINT, released_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_messages (id TEXT PRIMARY KEY, ref_id TEXT NOT NULL, ref_type TEXT NOT NULL, sender_id TEXT NOT NULL, content TEXT NOT NULL, created_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_ratings (id TEXT PRIMARY KEY, tx_id TEXT NOT NULL, from_user TEXT NOT NULL, to_user TEXT NOT NULL, score INT NOT NULL, created_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_loans (id TEXT PRIMARY KEY, lender_id TEXT NOT NULL, borrower_id TEXT, amount_sats BIGINT NOT NULL, interest_sats BIGINT NOT NULL, duration_hours INT NOT NULL, collateral TEXT, status TEXT DEFAULT 'open', invoice_id TEXT, payment_request TEXT, created_at BIGINT, funded_at BIGINT, due_at BIGINT, repaid_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_tasks (id TEXT PRIMARY KEY, poster_id TEXT NOT NULL, worker_id TEXT, title TEXT NOT NULL, description TEXT NOT NULL, reward_sats BIGINT NOT NULL, proof_required TEXT, status TEXT DEFAULT 'open', invoice_id TEXT, payment_request TEXT, proof_submission TEXT, created_at BIGINT, taken_at BIGINT, completed_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_predictions (id TEXT PRIMARY KEY, creator_id TEXT NOT NULL, asset TEXT NOT NULL, target_price NUMERIC NOT NULL, direction TEXT NOT NULL, resolve_at BIGINT NOT NULL, stake_sats BIGINT NOT NULL, creator_side TEXT NOT NULL, challenger_id TEXT, challenger_side TEXT, status TEXT DEFAULT 'open', winner_id TEXT, commission_sats BIGINT DEFAULT 0, invoice_id TEXT, payment_request TEXT, challenger_invoice_id TEXT, challenger_payment_request TEXT, created_at BIGINT, resolved_at BIGINT)`);
  await pool.query(`CREATE TABLE IF NOT EXISTS sato_data_listings (id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL, type TEXT NOT NULL, price_sats BIGINT NOT NULL, duration_hours INT, status TEXT DEFAULT 'active', created_at BIGINT)`);

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
    await pool.query('INSERT INTO sato_assets (id,name,type,symbol,contract_address,decimals,network,active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8) ON CONFLICT (id) DO NOTHING', [id,name,type,symbol,contract,decimals,network,now()]);
  }
  console.log('SATONERO DB initialized.');
}

// --- AUTO TIMERS ---
setInterval(async () => {
  try {
    // Auto-release swaps after 15 min
    const { rows: txs } = await pool.query("SELECT id FROM sato_transactions WHERE status='paid' AND paid_at < $1", [now() - 900000]);
    for (const { id } of txs) await releaseSwap(id);

    // Auto-default expired loans
    await pool.query("UPDATE sato_loans SET status='defaulted' WHERE status='active' AND due_at < $1", [now()]);

    // Auto-resolve predictions
    const { rows: preds } = await pool.query("SELECT * FROM sato_predictions WHERE status='active' AND resolve_at <= $1", [now()]);
    for (const p of preds) {
      const price = await getPrice(p.asset);
      if (!price) continue;
      const above = price >= Number(p.target_price);
      const yesWins = p.direction === 'above' ? above : !above;
      const creatorWins = (p.creator_side === 'yes') === yesWins;
      const winner = creatorWins ? p.creator_id : p.challenger_id;
      const total = Number(p.stake_sats) * 2;
      const comm = calcComm(total, 'prediction');
      await pool.query('UPDATE sato_predictions SET status=$1,winner_id=$2,commission_sats=$3,resolved_at=$4 WHERE id=$5', ['resolved', winner, comm, now(), p.id]);
      if (winner) await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [total - comm, winner]);
    }
  } catch(e) { console.error('Timer err:', e.message); }
}, 60000);

// --- ROUTES ---

// ASSETS
app.get('/api/assets', async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM sato_assets WHERE active=true ORDER BY type,name");
  res.json(rows);
});
app.post('/api/admin/assets', async (req, res) => {
  const { adminKey, name, type, symbol, contractAddress, decimals, network } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  const id = uid();
  await pool.query('INSERT INTO sato_assets (id,name,type,symbol,contract_address,decimals,network,active,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,true,$8)', [id, name, type, symbol||null, contractAddress||null, decimals||0, network||null, now()]);
  res.json({ ok: true, id });
});
app.patch('/api/admin/assets/:id', async (req, res) => {
  const { adminKey, active } = req.body;
  if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  await pool.query('UPDATE sato_assets SET active=$1 WHERE id=$2', [!!active, req.params.id]);
  res.json({ ok: true });
});

// USERS
app.get('/api/user/:id', async (req, res) => {
  await upsertUser(req.params.id, null);
  const { rows } = await pool.query('SELECT * FROM sato_users WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const u = rows[0];
  const { rows: listings } = await pool.query("SELECT * FROM sato_listings WHERE seller_id=$1 AND status='active' ORDER BY created_at DESC LIMIT 5", [req.params.id]);
  const { rows: ratings } = await pool.query('SELECT * FROM sato_ratings WHERE to_user=$1 ORDER BY created_at DESC LIMIT 10', [req.params.id]);
  res.json({ ...u, listings, ratings });
});
app.post('/api/user', async (req, res) => {
  const { userId, email } = req.body;
  if (!userId) return res.status(400).json({ error: 'userId required' });
  await upsertUser(userId, email);
  res.json({ ok: true });
});
app.post('/api/withdraw', async (req, res) => {
  try {
    const { userId, lightningAddress, amountSats } = req.body;
    if (!userId || !lightningAddress || !amountSats) return res.status(400).json({ error: 'Missing fields' });
    const { rows } = await pool.query('SELECT * FROM sato_users WHERE id=$1', [userId]);
    if (!rows.length) return res.status(404).json({ error: 'User not found' });
    const u = rows[0];
    if (u.balance_sats < amountSats) return res.status(400).json({ error: 'Insufficient balance' });
    await pool.query('UPDATE sato_users SET balance_sats=balance_sats-$1 WHERE id=$2', [amountSats, userId]);
    const result = await sendPayout(lightningAddress, amountSats);
    if (result.error) {
      await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [amountSats, userId]);
      return res.status(400).json({ error: result.error });
    }
    res.json({ ok: true, sent: amountSats });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// DEPOSIT to balance
app.post('/api/deposit', async (req, res) => {
  try {
    const { userId, amountSats } = req.body;
    if (!userId || !amountSats) return res.status(400).json({ error: 'Missing fields' });
    await upsertUser(userId, null);
    const inv = await createInvoice(amountSats, 'SATONERO deposit - ' + userId, BASE_URL + '/api/webhook/deposit/' + userId + '/' + amountSats);
    const qr = await QRCode.toDataURL('lightning:' + (inv.payment_request || inv.pr || ''));
    res.json({ payment_request: inv.payment_request || inv.pr, qr, checkout_url: inv.checkout_url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/webhook/deposit/:userId/:amount', async (req, res) => {
  const { userId, amount } = req.params;
  await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [Number(amount), userId]);
  res.json({ ok: true });
});

// SWAP LISTINGS
app.get('/api/listings', async (req, res) => {
  const { type } = req.query;
  let q = "SELECT l.*, a1.name AS offer_name, a1.type AS offer_type, a2.name AS want_name, a2.type AS want_type, u.rating, u.trusted FROM sato_listings l LEFT JOIN sato_assets a1 ON l.offer_asset=a1.id LEFT JOIN sato_assets a2 ON l.want_asset=a2.id LEFT JOIN sato_users u ON l.seller_id=u.id WHERE l.status='active'";
  const params = [];
  if (type && type !== 'all') { q += ' AND (a1.type=$1 OR a2.type=$1)'; params.push(type); }
  q += ' ORDER BY l.created_at DESC LIMIT 50';
  const { rows } = await pool.query(q, params);
  res.json(rows);
});
app.post('/api/listings', async (req, res) => {
  try {
    const { sellerId, offerAsset, offerAmount, wantAsset, wantAmount, description, email } = req.body;
    if (!sellerId || !offerAsset || !offerAmount || !wantAsset || !wantAmount) return res.status(400).json({ error: 'Missing fields' });
    await upsertUser(sellerId, email);
    const id = uid();
    await pool.query('INSERT INTO sato_listings (id,seller_id,offer_asset,offer_amount,want_asset,want_amount,description,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)', [id, sellerId, offerAsset, offerAmount, wantAsset, wantAmount, description||null, 'active', now()]);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.delete('/api/listings/:id', async (req, res) => {
  const { sellerId } = req.body;
  await pool.query("UPDATE sato_listings SET status='removed' WHERE id=$1 AND seller_id=$2", [req.params.id, sellerId]);
  res.json({ ok: true });
});

// ACCEPT SWAP
app.post('/api/swap', async (req, res) => {
  try {
    const { listingId, buyerId, email } = req.body;
    if (!listingId || !buyerId) return res.status(400).json({ error: 'Missing fields' });
    const { rows: ls } = await pool.query("SELECT * FROM sato_listings WHERE id=$1 AND status='active'", [listingId]);
    if (!ls.length) return res.status(404).json({ error: 'Listing not found or inactive' });
    const l = ls[0];
    if (l.seller_id === buyerId) return res.status(400).json({ error: 'Cannot buy own listing' });
    await upsertUser(buyerId, email);
    const txId = uid();
    const { rows: assetRows } = await pool.query('SELECT * FROM sato_assets WHERE id=$1', [l.want_asset]);
    const asset = assetRows[0];
    const commType = asset ? asset.type : 'crypto';
    const satsAmount = l.want_asset === 'sats' ? Number(l.want_amount) : 0;
    const comm = satsAmount ? calcComm(satsAmount, commType) : 0;

    let paymentRequest = null, invoiceId = null, qr = null, checkoutUrl = null;
    if (l.want_asset === 'sats' && satsAmount > 0) {
      const inv = await createInvoice(satsAmount, 'SATONERO swap ' + txId, BASE_URL + '/api/webhook/swap/' + txId);
      paymentRequest = inv.payment_request || inv.pr;
      invoiceId = inv.id;
      checkoutUrl = inv.checkout_url;
      if (paymentRequest) qr = await QRCode.toDataURL('lightning:' + paymentRequest);
    }

    await pool.query('INSERT INTO sato_transactions (id,listing_id,buyer_id,seller_id,offer_asset,offer_amount,want_asset,want_amount,commission_sats,invoice_id,payment_request,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)',
      [txId, listingId, buyerId, l.seller_id, l.offer_asset, l.offer_amount, l.want_asset, l.want_amount, comm, invoiceId, paymentRequest, paymentRequest ? 'pending' : 'manual', now()]);
    await pool.query("UPDATE sato_listings SET status='pending' WHERE id=$1", [listingId]);
    res.json({ txId, paymentRequest, qr, checkoutUrl, manual: !paymentRequest });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/tx/:id', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sato_transactions WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  res.json(rows[0]);
});

app.post('/api/webhook/swap/:txId', async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM sato_transactions WHERE id=$1 AND status='pending'", [req.params.txId]);
  if (!rows.length) return res.json({ ok: true });
  await pool.query('UPDATE sato_transactions SET status=$1,paid_at=$2 WHERE id=$3', ['paid', now(), req.params.txId]);
  res.json({ ok: true });
});

app.post('/api/tx/:id/confirm', async (req, res) => {
  try {
    const { buyerId } = req.body;
    const { rows } = await pool.query('SELECT * FROM sato_transactions WHERE id=$1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Not found' });
    const tx = rows[0];
    if (tx.buyer_id !== buyerId) return res.status(403).json({ error: 'Not buyer' });
    if (!['paid','manual'].includes(tx.status)) return res.status(400).json({ error: 'Cannot confir