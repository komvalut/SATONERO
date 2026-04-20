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
    if (!['paid','manual'].includes(tx.status)) return res.status(400).json({ error: 'Cannot confirm in status: ' + tx.status });
    await releaseSwap(req.params.id);
    // If manual swap (no Lightning), release directly
    if (tx.status === 'manual') {
      await pool.query('UPDATE sato_transactions SET status=$1,paid_at=$2,released_at=$3 WHERE id=$4', ['released', now(), now(), req.params.id]);
      const payout = Math.floor(Number(tx.offer_amount));
      await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1,total_trades=total_trades+1 WHERE id=$2', [payout, tx.seller_id]);
      await pool.query('UPDATE sato_users SET total_trades=total_trades+1 WHERE id=$1', [tx.buyer_id]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/tx/:id/dispute', async (req, res) => {
  const { userId, reason } = req.body;
  const { rows } = await pool.query('SELECT * FROM sato_transactions WHERE id=$1', [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Not found' });
  const tx = rows[0];
  if (tx.buyer_id !== userId && tx.seller_id !== userId) return res.status(403).json({ error: 'Not party to this swap' });
  await pool.query('UPDATE sato_transactions SET status=$1,dispute_reason=$2 WHERE id=$3', ['disputed', reason||'No reason', req.params.id]);
  res.json({ ok: true });
});

// RATINGS
app.post('/api/rate/:txId', async (req, res) => {
  try {
    const { fromUser, toUser, score } = req.body;
    if (!fromUser || !toUser || !score) return res.status(400).json({ error: 'Missing fields' });
    const existing = await pool.query('SELECT id FROM sato_ratings WHERE tx_id=$1 AND from_user=$2', [req.params.txId, fromUser]);
    if (existing.rows.length) return res.status(400).json({ error: 'Already rated' });
    await pool.query('INSERT INTO sato_ratings (id,tx_id,from_user,to_user,score,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [uid(), req.params.txId, fromUser, toUser, score, now()]);
    const { rows: rr } = await pool.query('SELECT AVG(score) AS avg FROM sato_ratings WHERE to_user=$1', [toUser]);
    await pool.query('UPDATE sato_users SET rating=$1 WHERE id=$2', [parseFloat(rr[0].avg).toFixed(1), toUser]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// CHAT
app.get('/api/chat/:refId', async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM sato_messages WHERE ref_id=$1 ORDER BY created_at ASC LIMIT 100', [req.params.refId]);
  res.json(rows);
});
app.post('/api/chat/:refId', async (req, res) => {
  const { senderId, content, refType } = req.body;
  if (!senderId || !content) return res.status(400).json({ error: 'Missing fields' });
  await pool.query('INSERT INTO sato_messages (id,ref_id,ref_type,sender_id,content,created_at) VALUES ($1,$2,$3,$4,$5,$6)', [uid(), req.params.refId, refType||'swap', senderId, content.slice(0,1000), now()]);
  res.json({ ok: true });
});

// LOANS
app.get('/api/loans', async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM sato_loans WHERE status='open' ORDER BY created_at DESC LIMIT 50");
  res.json(rows);
});
app.post('/api/loans', async (req, res) => {
  try {
    const { lenderId, amountSats, interestSats, durationHours, collateral, email } = req.body;
    if (!lenderId || !amountSats || !interestSats || !durationHours) return res.status(400).json({ error: 'Missing fields' });
    await upsertUser(lenderId, email);
    const { rows: u } = await pool.query('SELECT balance_sats FROM sato_users WHERE id=$1', [lenderId]);
    if (!u.length || u[0].balance_sats < amountSats) return res.status(400).json({ error: 'Insufficient balance. Deposit sats first.' });
    const id = uid();
    await pool.query('UPDATE sato_users SET balance_sats=balance_sats-$1 WHERE id=$2', [amountSats, lenderId]);
    await pool.query('INSERT INTO sato_loans (id,lender_id,amount_sats,interest_sats,duration_hours,collateral,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)', [id, lenderId, amountSats, interestSats, durationHours, collateral||null, 'open', now()]);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/loans/:id/take', async (req, res) => {
  try {
    const { borrowerId, email } = req.body;
    const { rows } = await pool.query("SELECT * FROM sato_loans WHERE id=$1 AND status='open'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Loan not found' });
    const l = rows[0];
    if (l.lender_id === borrowerId) return res.status(400).json({ error: 'Cannot borrow own loan' });
    await upsertUser(borrowerId, email);
    const dueAt = now() + l.duration_hours * 3600000;
    await pool.query('UPDATE sato_loans SET status=$1,borrower_id=$2,funded_at=$3,due_at=$4 WHERE id=$5', ['active', borrowerId, now(), dueAt, req.params.id]);
    await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [l.amount_sats, borrowerId]);
    res.json({ ok: true, dueAt });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/loans/:id/repay', async (req, res) => {
  try {
    const { borrowerId } = req.body;
    const { rows } = await pool.query("SELECT * FROM sato_loans WHERE id=$1 AND status='active'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Active loan not found' });
    const l = rows[0];
    if (l.borrower_id !== borrowerId) return res.status(403).json({ error: 'Not borrower' });
    const repay = Number(l.amount_sats) + Number(l.interest_sats);
    const { rows: u } = await pool.query('SELECT balance_sats FROM sato_users WHERE id=$1', [borrowerId]);
    if (!u.length || u[0].balance_sats < repay) return res.status(400).json({ error: 'Insufficient balance to repay' });
    const comm = calcComm(Number(l.interest_sats), 'lending');
    await pool.query('UPDATE sato_users SET balance_sats=balance_sats-$1 WHERE id=$2', [repay, borrowerId]);
    await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [repay - comm, l.lender_id]);
    await pool.query('UPDATE sato_loans SET status=$1,repaid_at=$2 WHERE id=$3', ['repaid', now(), req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/loans/:id/dispute', async (req, res) => {
  const { userId, reason } = req.body;
  await pool.query("UPDATE sato_loans SET status='disputed',collateral=$1 WHERE id=$2", [(reason||'disputed'), req.params.id]);
  res.json({ ok: true });
});

// TASKS
app.get('/api/tasks', async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM sato_tasks WHERE status IN ('open','taken','review') ORDER BY created_at DESC LIMIT 50");
  res.json(rows);
});
app.post('/api/tasks', async (req, res) => {
  try {
    const { posterId, title, description, rewardSats, proofRequired, email } = req.body;
    if (!posterId || !title || !description || !rewardSats) return res.status(400).json({ error: 'Missing fields' });
    await upsertUser(posterId, email);
    const id = uid();
    const inv = await createInvoice(rewardSats, 'SATONERO task escrow: ' + title, BASE_URL + '/api/webhook/task/' + id);
    const qr = await QRCode.toDataURL('lightning:' + (inv.payment_request || inv.pr || ''));
    await pool.query('INSERT INTO sato_tasks (id,poster_id,title,description,reward_sats,proof_required,status,invoice_id,payment_request,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
      [id, posterId, title, description, rewardSats, proofRequired||null, 'pending_payment', inv.id, inv.payment_request||inv.pr, now()]);
    res.json({ id, payment_request: inv.payment_request||inv.pr, qr, checkout_url: inv.checkout_url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/webhook/task/:id', async (req, res) => {
  await pool.query("UPDATE sato_tasks SET status='open' WHERE id=$1 AND status='pending_payment'", [req.params.id]);
  res.json({ ok: true });
});
app.post('/api/tasks/:id/take', async (req, res) => {
  const { workerId } = req.body;
  const { rows } = await pool.query("SELECT * FROM sato_tasks WHERE id=$1 AND status='open'", [req.params.id]);
  if (!rows.length) return res.status(404).json({ error: 'Task not available' });
  if (rows[0].poster_id === workerId) return res.status(400).json({ error: 'Cannot take own task' });
  await upsertUser(workerId, null);
  await pool.query("UPDATE sato_tasks SET status='taken',worker_id=$1,taken_at=$2 WHERE id=$3", [workerId, now(), req.params.id]);
  res.json({ ok: true });
});
app.post('/api/tasks/:id/submit', async (req, res) => {
  const { workerId, proof } = req.body;
  const { rows } = await pool.query("SELECT * FROM sato_tasks WHERE id=$1 AND worker_id=$2 AND status='taken'", [req.params.id, workerId]);
  if (!rows.length) return res.status(404).json({ error: 'Task not found or not yours' });
  await pool.query("UPDATE sato_tasks SET status='review',proof_submission=$1,completed_at=$2 WHERE id=$3", [proof||'(no proof)', now(), req.params.id]);
  res.json({ ok: true });
});
app.post('/api/tasks/:id/approve', async (req, res) => {
  try {
    const { posterId } = req.body;
    const { rows } = await pool.query("SELECT * FROM sato_tasks WHERE id=$1 AND poster_id=$2 AND status='review'", [req.params.id, posterId]);
    if (!rows.length) return res.status(404).json({ error: 'Task not found' });
    const t = rows[0];
    const comm = calcComm(Number(t.reward_sats), 'task');
    await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1,total_trades=total_trades+1 WHERE id=$2', [t.reward_sats - comm, t.worker_id]);
    await pool.query("UPDATE sato_tasks SET status='done' WHERE id=$1", [req.params.id]);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/tasks/:id/dispute', async (req, res) => {
  const { userId, reason } = req.body;
  await pool.query("UPDATE sato_tasks SET status='disputed',proof_submission=$1 WHERE id=$2", [(reason||'disputed'), req.params.id]);
  res.json({ ok: true });
});

// PREDICTIONS
app.get('/api/predictions', async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM sato_predictions WHERE status IN ('open','active') ORDER BY created_at DESC LIMIT 50");
  res.json(rows);
});
app.post('/api/predictions', async (req, res) => {
  try {
    const { creatorId, asset, targetPrice, direction, resolvesInMinutes, stakeSats, email } = req.body;
    if (!creatorId || !asset || !targetPrice || !direction || !resolvesInMinutes || !stakeSats) return res.status(400).json({ error: 'Missing fields' });
    await upsertUser(creatorId, email);
    const id = uid();
    const resolveAt = now() + Number(resolvesInMinutes) * 60000;
    const inv = await createInvoice(stakeSats, 'SATONERO prediction stake: ' + asset + ' ' + direction + ' ' + targetPrice, BASE_URL + '/api/webhook/prediction/' + id);
    const qr = await QRCode.toDataURL('lightning:' + (inv.payment_request||inv.pr||''));
    await pool.query('INSERT INTO sato_predictions (id,creator_id,asset,target_price,direction,resolve_at,stake_sats,creator_side,status,invoice_id,payment_request,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [id, creatorId, asset.toUpperCase(), targetPrice, direction, resolveAt, stakeSats, 'yes', 'pending_payment', inv.id, inv.payment_request||inv.pr, now()]);
    res.json({ id, payment_request: inv.payment_request||inv.pr, qr, checkout_url: inv.checkout_url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/webhook/prediction/:id', async (req, res) => {
  await pool.query("UPDATE sato_predictions SET status='open' WHERE id=$1 AND status='pending_payment'", [req.params.id]);
  res.json({ ok: true });
});
app.post('/api/predictions/:id/challenge', async (req, res) => {
  try {
    const { challengerId, email } = req.body;
    const { rows } = await pool.query("SELECT * FROM sato_predictions WHERE id=$1 AND status='open'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Prediction not found' });
    const p = rows[0];
    if (p.creator_id === challengerId) return res.status(400).json({ error: 'Cannot challenge own prediction' });
    await upsertUser(challengerId, email);
    const inv = await createInvoice(p.stake_sats, 'SATONERO challenge: ' + p.asset + ' ' + p.direction + ' ' + p.target_price, BASE_URL + '/api/webhook/prediction/' + req.params.id + '/challenger');
    const qr = await QRCode.toDataURL('lightning:' + (inv.payment_request||inv.pr||''));
    await pool.query('UPDATE sato_predictions SET challenger_id=$1,challenger_side=$2,challenger_invoice_id=$3,challenger_payment_request=$4,status=$5 WHERE id=$6',
      [challengerId, 'no', inv.id, inv.payment_request||inv.pr, 'pending_challenger', req.params.id]);
    res.json({ payment_request: inv.payment_request||inv.pr, qr, checkout_url: inv.checkout_url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/webhook/prediction/:id/challenger', async (req, res) => {
  await pool.query("UPDATE sato_predictions SET status='active' WHERE id=$1 AND status='pending_challenger'", [req.params.id]);
  res.json({ ok: true });
});

// DATA MARKETPLACE
app.get('/api/data', async (req, res) => {
  const { rows } = await pool.query("SELECT * FROM sato_data_listings WHERE status='active' ORDER BY created_at DESC LIMIT 50");
  res.json(rows);
});
app.post('/api/data', async (req, res) => {
  try {
    const { sellerId, title, description, type, priceSats, durationHours, email } = req.body;
    if (!sellerId || !title || !description || !type || !priceSats) return res.status(400).json({ error: 'Missing fields' });
    await upsertUser(sellerId, email);
    const id = uid();
    await pool.query('INSERT INTO sato_data_listings (id,seller_id,title,description,type,price_sats,duration_hours,status,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [id, sellerId, title, description, type, priceSats, durationHours||null, 'active', now()]);
    res.json({ ok: true, id });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/data/:id/buy', async (req, res) => {
  try {
    const { buyerId, email } = req.body;
    const { rows } = await pool.query("SELECT * FROM sato_data_listings WHERE id=$1 AND status='active'", [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'Listing not found' });
    const d = rows[0];
    await upsertUser(buyerId, email);
    const txId = uid();
    const inv = await createInvoice(d.price_sats, 'SATONERO data: ' + d.title, BASE_URL + '/api/webhook/data/' + txId + '/' + d.seller_id + '/' + d.price_sats);
    const qr = await QRCode.toDataURL('lightning:' + (inv.payment_request||inv.pr||''));
    res.json({ txId, payment_request: inv.payment_request||inv.pr, qr, checkout_url: inv.checkout_url });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/webhook/data/:txId/:sellerId/:amount', async (req, res) => {
  const { sellerId, amount } = req.params;
  const comm = calcComm(Number(amount), 'voucher');
  await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [Number(amount) - comm, sellerId]);
  res.json({ ok: true });
});

// ADMIN
app.get('/api/admin/disputes', async (req, res) => {
  if (req.query.adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  const { rows: swaps } = await pool.query("SELECT *,'swap' AS kind FROM sato_transactions WHERE status='disputed' ORDER BY created_at DESC");
  const { rows: loans } = await pool.query("SELECT *,'loan' AS kind FROM sato_loans WHERE status='disputed' ORDER BY created_at DESC");
  const { rows: tasks } = await pool.query("SELECT *,'task' AS kind FROM sato_tasks WHERE status='disputed' ORDER BY created_at DESC");
  res.json({ swaps, loans, tasks });
});
app.post('/api/admin/resolve', async (req, res) => {
  try {
    const { adminKey, id, winner, type } = req.body;
    if (adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
    if (type === 'swap') {
      const { rows } = await pool.query('SELECT * FROM sato_transactions WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const tx = rows[0];
      const userId = winner === 'buyer' ? tx.buyer_id : tx.seller_id;
      await pool.query('UPDATE sato_transactions SET status=$1,released_at=$2 WHERE id=$3', ['resolved', now(), id]);
      if (tx.offer_amount) await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [Math.floor(Number(tx.offer_amount)), userId]);
    } else if (type === 'loan') {
      const { rows } = await pool.query('SELECT * FROM sato_loans WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const l = rows[0];
      const userId = winner === 'lender' ? l.lender_id : l.borrower_id;
      await pool.query("UPDATE sato_loans SET status='resolved' WHERE id=$1", [id]);
      await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [Number(l.amount_sats), userId]);
    } else if (type === 'task') {
      const { rows } = await pool.query('SELECT * FROM sato_tasks WHERE id=$1', [id]);
      if (!rows.length) return res.status(404).json({ error: 'Not found' });
      const t = rows[0];
      const userId = winner === 'worker' ? t.worker_id : t.poster_id;
      await pool.query("UPDATE sato_tasks SET status='resolved' WHERE id=$1", [id]);
      if (userId && t.reward_sats) await pool.query('UPDATE sato_users SET balance_sats=balance_sats+$1 WHERE id=$2', [Number(t.reward_sats), userId]);
    }
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/admin/stats', async (req, res) => {
  if (req.query.adminKey !== ADMIN_KEY) return res.status(403).json({ error: 'Forbidden' });
  const { rows: u } = await pool.query('SELECT COUNT(*) AS cnt FROM sato_users');
  const { rows: l } = await pool.query("SELECT COUNT(*) AS cnt FROM sato_listings WHERE status='active'");
  const { rows: tx } = await pool.query("SELECT COUNT(*) AS cnt, COALESCE(SUM(commission_sats),0) AS rev FROM sato_transactions WHERE status IN ('released','resolved')");
  const { rows: tsk } = await pool.query("SELECT COUNT(*) AS cnt FROM sato_tasks WHERE status='done'");
  res.json({ users: u[0].cnt, listings: l[0].cnt, transactions: tx[0].cnt, revenue_sats: tx[0].rev, tasks_done: tsk[0].cnt });
});

// ─── HTML ──────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang='en'>
<head>
<meta charset='UTF-8'>
<meta name='viewport' content='width=device-width,initial-scale=1'>
<title>SATONERO &#9889; P2P Market</title>
<meta name='theme-color' content='#ff5500'>
<meta name='description' content='Micro P2P marketplace - swap crypto, lend sats, earn on tasks, predict prices. No registration. Lightning payments.'>
<meta name='mobile-web-app-capable' content='yes'>
<meta name='apple-mobile-web-app-capable' content='yes'>
<meta name='apple-mobile-web-app-status-bar-style' content='black-translucent'>
<meta name='apple-mobile-web-app-title' content='SATONERO'>
<link rel='manifest' href='/manifest.json'>
<link rel='apple-touch-icon' href='/icon.svg'>
<style>
:root{--a:#ff5500;--b:#cc1a00;}
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#0c0f14;background-image:radial-gradient(circle,#1c2535 1.5px,transparent 1.5px);background-size:22px 22px;color:#e2e8f0;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;min-height:100vh;}
a{color:inherit;text-decoration:none;}
header{background:#080c12;border-bottom:1px solid #1e2d40;padding:10px 16px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:50;}
.logo{font-size:1.2em;font-weight:800;color:#ff5500;letter-spacing:-0.5px;}
.logo span{color:#e2e8f0;}
nav{display:flex;gap:4px;flex-wrap:wrap;}
nav button{background:none;border:none;color:#94a3b8;cursor:pointer;padding:6px 10px;border-radius:8px;font-size:0.82em;font-weight:600;}
nav button.active,nav button:hover{background:#1e2d40;color:#e2e8f0;}
main{max-width:720px;margin:0 auto;padding:16px;}
.tab-content{display:none;}
.tab-content.active{display:block;}
.card{background:#0f1824;border:1px solid #1e2d40;border-radius:14px;padding:16px;margin-bottom:12px;}
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:12px;}
.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:0.75em;font-weight:600;}
.badge-active,.badge-open{background:#052e16;color:#4ade80;border:1px solid #166534;}
.badge-pending{background:#1c1500;color:#facc15;border:1px solid #854d0e;}
.badge-paid{background:#0c1a2e;color:#60a5fa;border:1px solid #1e40af;}
.badge-disputed{background:#2d0a0a;color:#fc8181;border:1px solid #7f1d1d;}
.badge-released,.badge-done,.badge-repaid,.badge-resolved{background:#0a1a0a;color:#4ade80;border:1px solid #166534;}
.badge-defaulted{background:#2d0a0a;color:#fc8181;}
.badge-taken,.badge-review{background:#1a0a2e;color:#a78bfa;border:1px solid #5b21b6;}
.badge-trusted{background:#1a1500;color:#fbbf24;border:1px solid #b45309;font-size:0.7em;}
.muted{color:#64748b;font-size:0.85em;}
h2{font-size:1.1em;font-weight:700;margin-bottom:12px;color:#e2e8f0;}
h3{font-size:0.95em;font-weight:700;margin-bottom:6px;}
input,select,textarea{width:100%;background:#0a1018;border:1px solid #1e2d40;color:#e2e8f0;border-radius:8px;padding:8px 12px;font-size:0.9em;margin-bottom:8px;outline:none;}
input:focus,select:focus,textarea:focus{border-color:#ff5500;}
textarea{resize:vertical;min-height:60px;}
.btn{display:inline-flex;align-items:center;gap:6px;padding:8px 16px;border:none;border-radius:10px;font-weight:600;font-size:0.88em;cursor:pointer;background:linear-gradient(135deg,var(--a),var(--b));color:#fff;}
.btn:disabled{opacity:0.5;cursor:not-allowed;}
.btn-sm{padding:5px 10px;font-size:0.8em;}
.btn-ghost{background:none;border:1px solid #1e2d40;color:#94a3b8;}
.btn-ghost:hover{border-color:#ff5500;color:#ff5500;}
.btn-danger{background:linear-gradient(135deg,#7f1d1d,#450a0a);color:#fca5a5;border:1px solid #ef4444;}
.btn-success{background:linear-gradient(135deg,#14532d,#052e16);color:#4ade80;border:1px solid #16a34a;}
.filter-bar{display:flex;gap:6px;margin-bottom:12px;flex-wrap:wrap;}
.filter-bar button{background:#0f1824;border:1px solid #1e2d40;color:#94a3b8;padding:5px 12px;border-radius:20px;font-size:0.82em;cursor:pointer;}
.filter-bar button.active{background:#ff5500;border-color:#ff5500;color:#fff;}
.row{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;}
.stars{color:#fbbf24;font-size:0.85em;}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,0.85);z-index:200;overflow-y:auto;}
.overlay.open{display:block;}
.overlay-inner{max-width:480px;margin:40px auto 80px;padding:0 16px;}
.overlay-box{background:#0f1824;border:1px solid #1e2d40;border-radius:16px;padding:20px;}
.overlay-close{float:right;background:none;border:none;color:#64748b;font-size:1.2em;cursor:pointer;line-height:1;}
#status-bar{min-height:28px;font-size:0.88em;margin-bottom:10px;padding:6px 12px;border-radius:8px;display:none;}
#status-bar.show{display:block;}
#status-bar.ok{background:#052e16;color:#4ade80;border:1px solid #166534;}
#status-bar.err{background:#2d0a0a;color:#fc8181;border:1px solid #7f1d1d;}
.nick-bar{background:#080c12;border:1px solid #1e2d40;border-radius:10px;padding:10px 14px;margin-bottom:12px;display:flex;align-items:center;gap:8px;flex-wrap:wrap;}
.asset-chip{display:inline-flex;align-items:center;gap:4px;background:#1e2d40;border-radius:6px;padding:3px 8px;font-size:0.8em;font-weight:600;}
.swap-arrow{color:#ff5500;font-size:1.2em;margin:0 6px;}
.progress-bar{height:4px;background:#1e2d40;border-radius:2px;margin:8px 0;}
.progress-fill{height:100%;background:#ff5500;border-radius:2px;transition:width 0.3s;}
.chat-msg{padding:8px 10px;border-radius:8px;margin-bottom:6px;font-size:0.88em;}
.chat-msg.mine{background:#1a1000;border:1px solid #ff5500;margin-left:20px;}
.chat-msg.other{background:#0a1420;border:1px solid #1e2d40;margin-right:20px;}
.chat-msg .sender{font-size:0.75em;color:#64748b;margin-bottom:2px;}
.chat-input-row{display:flex;gap:6px;margin-top:8px;}
.chat-input-row input{margin:0;flex:1;}
.two-col{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.pred-chip{background:#1e2d40;border-radius:8px;padding:4px 10px;font-size:0.82em;display:inline-block;margin-right:4px;}
.pred-chip.above{border-left:3px solid #4ade80;}
.pred-chip.below{border-left:3px solid #fc8181;}
@media(max-width:480px){.two-col{grid-template-columns:1fr;}.card-grid{grid-template-columns:1fr;}}
.btn-theme{background:#1e2d40;border:1px solid #2a3a50;padding:0;width:36px;height:36px;border-radius:50%;font-size:1.1em;display:inline-flex;align-items:center;justify-content:center;cursor:pointer;transition:transform 0.2s;}
.btn-theme:hover{transform:scale(1.15);}
.btn-lang{background:#1e2d40;border:1px solid #2a3a50;padding:0 10px;height:36px;border-radius:20px;font-size:0.8em;font-weight:700;display:inline-flex;align-items:center;gap:4px;color:#94a3b8;cursor:pointer;transition:transform 0.2s;}
.btn-lang:hover{transform:scale(1.07);color:#e2e8f0;}
.header-controls{display:flex;align-items:center;gap:6px;margin-left:8px;flex-shrink:0;}
</style>
</head>
<body>
<header>
  <div class='logo'>&#9889;<span>SATO</span>NERO</div>
  <nav>
    <button id='nav-swap' class='active' onclick='switchTab("swap")'>&#128257; Swap</button>
    <button id='nav-lend' onclick='switchTab("lend")'>&#128176; Lend</button>
    <button id='nav-tasks' onclick='switchTab("tasks")'>&#9989; Tasks</button>
    <button id='nav-predict' onclick='switchTab("predict")'>&#127919; Predict</button>
    <button id='nav-data' onclick='switchTab("data")'>&#128274; Data</button>
    <button id='nav-profile' onclick='switchTab("profile")'>&#128100; Me</button>
    <button id='nav-admin' onclick='switchTab("admin")'>&#9881;</button>
  </nav>
  <div class='header-controls'>
    <button id='lang-btn' class='btn-lang' onclick='cycleLang()'>&#127760; <span id='lang-label'>EN</span></button>
    <button id='theme-btn' class='btn-theme' onclick='cycleTheme()'>&#128293;</button>
  </div>
</header>
<main>
  <div id='status-bar'></div>
  <div id='nick-bar' class='nick-bar' style='display:none'>
    <span class='muted'>Nick:</span>
    <strong id='nick-display'></strong>
    <button class='btn btn-sm btn-ghost' onclick='changeNick()'>Change</button>
    <span style='margin-left:auto;font-size:0.82em;color:#4ade80;'>&#9679; Balance: <strong id='bal-display'>0</strong> sats</span>
    <button class='btn btn-sm' onclick='showDepositModal()'>+ Deposit</button>
  </div>

  <div id='tab-swap' class='tab-content active'>
    <div class='row' style='margin-bottom:12px'>
      <h2 data-i18n='swap_title'>&#128257; Swap Market</h2>
      <button class='btn btn-sm' data-i18n='btn_new_listing' onclick='showNewListingModal()'>+ New Listing</button>
    </div>
    <div class='filter-bar'>
      <button class='active' data-filter='all' data-i18n='filter_all' onclick='setSwapFilter(this)'>All</button>
      <button data-filter='crypto' data-i18n='filter_crypto' onclick='setSwapFilter(this)'>Crypto</button>
      <button data-filter='voucher' data-i18n='filter_voucher' onclick='setSwapFilter(this)'>Vouchers</button>
      <button data-filter='giftcard' data-i18n='filter_gift' onclick='setSwapFilter(this)'>Gift Cards</button>
    </div>
    <div id='swap-list'><p class='muted' data-i18n='loading'>Loading...</p></div>
  </div>

  <div id='tab-lend' class='tab-content'>
    <div class='row' style='margin-bottom:12px'>
      <h2 data-i18n='lend_title'>&#128176; P2P Lending</h2>
      <button class='btn btn-sm' data-i18n='btn_new_loan' onclick='showNewLoanModal()'>+ Offer Loan</button>
    </div>
    <div id='loan-list'><p class='muted' data-i18n='loading'>Loading...</p></div>
  </div>

  <div id='tab-tasks' class='tab-content'>
    <div class='row' style='margin-bottom:12px'>
      <h2 data-i18n='tasks_title'>&#9989; Micro Tasks</h2>
      <button class='btn btn-sm' data-i18n='btn_new_task' onclick='showNewTaskModal()'>+ Post Task</button>
    </div>
    <div id='task-list'><p class='muted' data-i18n='loading'>Loading...</p></div>
  </div>

  <div id='tab-predict' class='tab-content'>
    <div class='row' style='margin-bottom:12px'>
      <h2 data-i18n='predict_title'>&#127919; Price Prediction</h2>
      <button class='btn btn-sm' data-i18n='btn_new_pred' onclick='showNewPredictModal()'>+ Create Prediction</button>
    </div>
    <div id='predict-list'><p class='muted' data-i18n='loading'>Loading...</p></div>
  </div>

  <div id='tab-data' class='tab-content'>
    <div class='row' style='margin-bottom:12px'>
      <h2 data-i18n='data_title'>&#128274; Data Market</h2>
      <button class='btn btn-sm' data-i18n='btn_new_data' onclick='showNewDataModal()'>+ Sell Access</button>
    </div>
    <div id='data-list'><p class='muted' data-i18n='loading'>Loading...</p></div>
  </div>

  <div id='tab-profile' class='tab-content'>
    <h2 data-i18n='nav_me'>&#128100; Me</h2>
    <div id='profile-content'><p class='muted'>Uloguj se ili unesi nickname.</p></div>
  </div>

  <div id='tab-admin' class='tab-content'>
    <h2>&#9881; Admin Panel</h2>
    <div class='card'>
      <input id='admin-key-inp' type='password' placeholder='Admin Key'>
      <button class='btn' onclick='adminLogin()'>Login</button>
      <p class='muted' style='margin-top:10px;font-size:0.8em;'>&#9993; Support email: <a href='mailto:__ADMIN_EMAIL__' style='color:#ff5500;'>__ADMIN_EMAIL__</a></p>
    </div>
    <div id='admin-content' style='display:none'></div>
  </div>
</main>

<!-- MODAL OVERLAY -->
<div id='overlay' class='overlay' onclick='overlayBgClick(event)'>
  <div class='overlay-inner'>
    <div class='overlay-box'>
      <button class='overlay-close' onclick='closeOverlay()'>&#x2715;</button>
      <div id='overlay-content'></div>
    </div>
  </div>
</div>

<!-- CHAT OVERLAY -->
<div id='chat-overlay' class='overlay' onclick='chatBgClick(event)'>
  <div class='overlay-inner'>
    <div class='overlay-box'>
      <button class='overlay-close' onclick='closeChatOverlay()'>&#x2715;</button>
      <div id='chat-content'></div>
    </div>
  </div>
</div>

<script>
var _nick = localStorage.getItem('sato_nick') || '';
var _adminKey = '';
var _assets = [];
var _swapFilter = 'all';
var _chatRefId = '';
var _chatRefType = '';
var _chatTimer = null;
var _payPollTimer = null;
var _activeTab = 'swap';

var THEMES=[{e:'&#128293;',a:'#ff5500',b:'#cc1a00'},{e:'&#128153;',a:'#1d4ed8',b:'#1e40af'},{e:'&#128154;',a:'#16a34a',b:'#15803d'},{e:'&#128155;',a:'#7c3aed',b:'#6d28d9'},{e:'&#128156;',a:'#db2777',b:'#be185d'},{e:'&#129473;',a:'#0891b2',b:'#0e7490'},{e:'&#128149;',a:'#d97706',b:'#92400e'}];
var _themeIdx=Number(localStorage.getItem('sato_theme')||0);
function applyTheme(idx){var th=THEMES[idx%THEMES.length];document.documentElement.style.setProperty('--a',th.a);document.documentElement.style.setProperty('--b',th.b);var btn=document.getElementById('theme-btn');if(btn)btn.innerHTML=th.e;}
function cycleTheme(){_themeIdx=(_themeIdx+1)%THEMES.length;localStorage.setItem('sato_theme',_themeIdx);applyTheme(_themeIdx);}

var LANGS=[
  {code:'EN',flag:'&#127482;&#127480;',strings:{nav_swap:'&#128257; Swap',nav_lend:'&#128176; Lend',nav_tasks:'&#9989; Tasks',nav_predict:'&#127919; Predict',nav_data:'&#128274; Data',nav_me:'&#128100; Me',swap_title:'&#128257; Swap Market',lend_title:'&#128176; P2P Lending',tasks_title:'&#9989; Micro Tasks',predict_title:'&#127919; Price Prediction',data_title:'&#128274; Data Market',btn_new_listing:'+ New Listing',btn_new_loan:'+ Offer Loan',btn_new_task:'+ Post Task',btn_new_pred:'+ Create Prediction',btn_new_data:'+ Sell Access',filter_all:'All',filter_crypto:'Crypto',filter_voucher:'Vouchers',filter_gift:'Gift Cards',no_listings:'No active listings.',no_loans:'No active loan offers.',no_tasks:'No active tasks.',no_preds:'No active predictions.',no_data:'No active data listings.',btn_trade:'Trade &#9889;',btn_take_loan:'Take Loan',btn_challenge:'Accept Challenge &#9889;',btn_take_task:'Accept',btn_submit_proof:'Submit proof',btn_approve:'Approve',btn_dispute:'Dispute',btn_buy:'Buy &#9889;',btn_confirm:'&#10003; Confirm receipt',btn_open_dispute:'&#9888; Open dispute',no_msgs:'No messages yet.',chat_placeholder:'Message...',loading:'Loading...',interest:'Interest',term:'Term',collateral:'Collateral',contact:'Contact / Support',btn_deposit:'+ Deposit',btn_login:'Login',disputes_title:'&#9888; Disputes',assets_title:'&#128290; Assets'}},
  {code:'SR',flag:'&#127463;&#127462;',strings:{nav_swap:'&#128257; Swap',nav_lend:'&#128176; Zajam',nav_tasks:'&#9989; Taskovi',nav_predict:'&#127919; Predikcija',nav_data:'&#128274; Data',nav_me:'&#128100; Ja',swap_title:'&#128257; Swap Trznica',lend_title:'&#128176; P2P Pozajmice',tasks_title:'&#9989; Micro Taskovi',predict_title:'&#127919; Price Predikcija',data_title:'&#128274; Data Trznica',btn_new_listing:'+ Novi Oglas',btn_new_loan:'+ Ponudi Zajam',btn_new_task:'+ Postavi Task',btn_new_pred:'+ Kreiraj Predikciju',btn_new_data:'+ Prodaj Pristup',filter_all:'Sve',filter_crypto:'Crypto',filter_voucher:'Voucheri',filter_gift:'Gift Karte',no_listings:'Nema aktivnih oglasa.',no_loans:'Nema ponuda zajma.',no_tasks:'Nema aktivnih taskova.',no_preds:'Nema aktivnih predikcija.',no_data:'Nema aktivnih ponuda.',btn_trade:'Zameni &#9889;',btn_take_loan:'Uzmi zajam',btn_challenge:'Prihvati izazov &#9889;',btn_take_task:'Prihvati',btn_submit_proof:'Podnesi dokaz',btn_approve:'Odobri',btn_dispute:'Spor',btn_buy:'Kupi &#9889;',btn_confirm:'&#10003; Potvrdi prijem',btn_open_dispute:'&#9888; Otvori spor',no_msgs:'Nema poruka jos.',chat_placeholder:'Poruka...',loading:'Ucitavanje...',interest:'Kamata',term:'Rok',collateral:'Kolateral',contact:'Kontakt / Podrska',btn_deposit:'+ Uplati',btn_login:'Prijava',disputes_title:'&#9888; Sporovi',assets_title:'&#128290; Asseti'}},
  {code:'DE',flag:'&#127465;&#127466;',strings:{nav_swap:'&#128257; Swap',nav_lend:'&#128176; Kredit',nav_tasks:'&#9989; Aufgaben',nav_predict:'&#127919; Prognose',nav_data:'&#128274; Daten',nav_me:'&#128100; Ich',swap_title:'&#128257; Swap Markt',lend_title:'&#128176; P2P Kredit',tasks_title:'&#9989; Micro Aufgaben',predict_title:'&#127919; Kurs-Prognose',data_title:'&#128274; Datenmarkt',btn_new_listing:'+ Neues Angebot',btn_new_loan:'+ Kredit anbieten',btn_new_task:'+ Aufgabe posten',btn_new_pred:'+ Prognose erstellen',btn_new_data:'+ Zugang verkaufen',filter_all:'Alle',filter_crypto:'Krypto',filter_voucher:'Gutscheine',filter_gift:'Geschenkkarten',no_listings:'Keine aktiven Angebote.',no_loans:'Keine Kreditangebote.',no_tasks:'Keine aktiven Aufgaben.',no_preds:'Keine aktiven Prognosen.',no_data:'Keine aktiven Angebote.',btn_trade:'Tauschen &#9889;',btn_take_loan:'Kredit nehmen',btn_challenge:'Herausforderung &#9889;',btn_take_task:'Annehmen',btn_submit_proof:'Beweis einreichen',btn_approve:'Genehmigen',btn_dispute:'Streit',btn_buy:'Kaufen &#9889;',btn_confirm:'&#10003; Empfang bestatigen',btn_open_dispute:'&#9888; Streit offnen',no_msgs:'Noch keine Nachrichten.',chat_placeholder:'Nachricht...',loading:'Laden...',interest:'Zinsen',term:'Laufzeit',collateral:'Sicherheit',contact:'Kontakt / Support',btn_deposit:'+ Einzahlen',btn_login:'Anmelden',disputes_title:'&#9888; Streitigkeiten',assets_title:'&#128290; Assets'}},
  {code:'RU',flag:'&#127479;&#127482;',strings:{nav_swap:'&#128257; Obmen',nav_lend:'&#128176; Zaym',nav_tasks:'&#9989; Zadachi',nav_predict:'&#127919; Prognoz',nav_data:'&#128274; Dannye',nav_me:'&#128100; Ya',swap_title:'&#128257; Rynok obmena',lend_title:'&#128176; P2P Kredit',tasks_title:'&#9989; Mikro zadachi',predict_title:'&#127919; Tsenovoy prognoz',data_title:'&#128274; Rynok dannykh',btn_new_listing:'+ Novoe obyavlenie',btn_new_loan:'+ Predlozhit zaym',btn_new_task:'+ Razmestit zadachu',btn_new_pred:'+ Sozdat prognoz',btn_new_data:'+ Prodat dostup',filter_all:'Vse',filter_crypto:'Kripto',filter_voucher:'Vouchery',filter_gift:'Podarochnyye karty',no_listings:'Net aktivnykh obyavleniy.',no_loans:'Net predlozheniy zayma.',no_tasks:'Net aktivnykh zadach.',no_preds:'Net aktivnykh prognozov.',no_data:'Net aktivnykh predlozheniy.',btn_trade:'Obmenyat &#9889;',btn_take_loan:'Vzyat zaym',btn_challenge:'Prinyat vyzov &#9889;',btn_take_task:'Prinyat',btn_submit_proof:'Otpravit dokazatelstvo',btn_approve:'Odobrit',btn_dispute:'Spor',btn_buy:'Kupit &#9889;',btn_confirm:'&#10003; Podtverdit polucheniye',btn_open_dispute:'&#9888; Otkryt spor',no_msgs:'Soobshcheniy poka net.',chat_placeholder:'Soobshcheniye...',loading:'Zagruzka...',interest:'Protsent',term:'Srok',collateral:'Zalog',contact:'Kontakt / Podderzhka',btn_deposit:'+ Popolnit',btn_login:'Voyti',disputes_title:'&#9888; Spory',assets_title:'&#128290; Aktivy'}},
  {code:'ES',flag:'&#127466;&#127480;',strings:{nav_swap:'&#128257; Swap',nav_lend:'&#128176; Prestamo',nav_tasks:'&#9989; Tareas',nav_predict:'&#127919; Prediccion',nav_data:'&#128274; Datos',nav_me:'&#128100; Yo',swap_title:'&#128257; Mercado Swap',lend_title:'&#128176; Prestamo P2P',tasks_title:'&#9989; Micro Tareas',predict_title:'&#127919; Prediccion de precio',data_title:'&#128274; Mercado de datos',btn_new_listing:'+ Nuevo anuncio',btn_new_loan:'+ Ofrecer prestamo',btn_new_task:'+ Publicar tarea',btn_new_pred:'+ Crear prediccion',btn_new_data:'+ Vender acceso',filter_all:'Todo',filter_crypto:'Cripto',filter_voucher:'Vales',filter_gift:'Tarjetas regalo',no_listings:'No hay anuncios activos.',no_loans:'No hay ofertas de prestamo.',no_tasks:'No hay tareas activas.',no_preds:'No hay predicciones activas.',no_data:'No hay anuncios activos.',btn_trade:'Intercambiar &#9889;',btn_take_loan:'Tomar prestamo',btn_challenge:'Aceptar desafio &#9889;',btn_take_task:'Aceptar',btn_submit_proof:'Enviar prueba',btn_approve:'Aprobar',btn_dispute:'Disputa',btn_buy:'Comprar &#9889;',btn_confirm:'&#10003; Confirmar recibo',btn_open_dispute:'&#9888; Abrir disputa',no_msgs:'No hay mensajes aun.',chat_placeholder:'Mensaje...',loading:'Cargando...',interest:'Interes',term:'Plazo',collateral:'Garantia',contact:'Contacto / Soporte',btn_deposit:'+ Depositar',btn_login:'Iniciar sesion',disputes_title:'&#9888; Disputas',assets_title:'&#128290; Activos'}},
  {code:'TR',flag:'&#127481;&#127479;',strings:{nav_swap:'&#128257; Takas',nav_lend:'&#128176; Kredi',nav_tasks:'&#9989; Gorevler',nav_predict:'&#127919; Tahmin',nav_data:'&#128274; Veri',nav_me:'&#128100; Ben',swap_title:'&#128257; Takas Piyasasi',lend_title:'&#128176; P2P Kredi',tasks_title:'&#9989; Mikro Gorevler',predict_title:'&#127919; Fiyat Tahmini',data_title:'&#128274; Veri Piyasasi',btn_new_listing:'+ Yeni Ilan',btn_new_loan:'+ Kredi Sun',btn_new_task:'+ Gorev Yayinla',btn_new_pred:'+ Tahmin Olustur',btn_new_data:'+ Erisim Sat',filter_all:'Hepsi',filter_crypto:'Kripto',filter_voucher:'Kuponlar',filter_gift:'Hediye Kartlari',no_listings:'Aktif ilan yok.',no_loans:'Kredi teklifi yok.',no_tasks:'Aktif gorev yok.',no_preds:'Aktif tahmin yok.',no_data:'Aktif teklif yok.',btn_trade:'Takas Et &#9889;',btn_take_loan:'Kredi Al',btn_challenge:'Meydan Oku &#9889;',btn_take_task:'Kabul Et',btn_submit_proof:'Kanit gonder',btn_approve:'Onayla',btn_dispute:'Anlasmazlik',btn_buy:'Satin Al &#9889;',btn_confirm:'&#10003; Alindi onayla',btn_open_dispute:'&#9888; Anlasmazlik ac',no_msgs:'Henuz mesaj yok.',chat_placeholder:'Mesaj...',loading:'Yukleniyor...',interest:'Faiz',term:'Sure',collateral:'Teminat',contact:'Iletisim / Destek',btn_deposit:'+ Yatir',btn_login:'Giris Yap',disputes_title:'&#9888; Anlasmazliklar',assets_title:'&#128290; Varliklar'}}
];
var _langIdx=Number(localStorage.getItem('sato_lang')||0);
function t(key){var l=LANGS[_langIdx%LANGS.length];return(l&&l.strings[key])||LANGS[0].strings[key]||key;}
function cycleLang(){_langIdx=(_langIdx+1)%LANGS.length;localStorage.setItem('sato_lang',_langIdx);applyLang();if(_activeTab==='swap')loadSwap();else if(_activeTab==='lend')loadLoans();else if(_activeTab==='tasks')loadTasks();else if(_activeTab==='predict')loadPredictions();else if(_activeTab==='data')loadData();}
function applyLang(){
  var l=LANGS[_langIdx%LANGS.length];
  var lb=document.getElementById('lang-label');if(lb)lb.innerHTML=l.flag+' '+l.code;
  var navMap={swap:'nav-swap',lend:'nav-lend',tasks:'nav-tasks',predict:'nav-predict',data:'nav-data',me:'nav-profile'};
  var keyMap={swap:'nav_swap',lend:'nav_lend',tasks:'nav_tasks',predict:'nav_predict',data:'nav_data',me:'nav_me'};
  for(var k in navMap){var btn=document.getElementById(navMap[k]);if(btn)btn.innerHTML=t(keyMap[k]);}
  document.querySelectorAll('[data-i18n]').forEach(function(el){var k=el.getAttribute('data-i18n');if(k)el.innerHTML=t(k);});
  var fc=document.getElementById('footer-contact');if(fc)fc.textContent=t('contact');
}

function setStatus(msg, err) {
  var el = document.getElementById('status-bar');
  el.textContent = msg;
  el.className = 'show ' + (err ? 'err' : 'ok');
  setTimeout(function() { el.className = ''; }, 4000);
}

function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function(c) {
    return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
  });
}

function fmtTime(ms) {
  if (!ms) return '';
  var d = new Date(ms);
  return d.toLocaleString();
}

function timeTo(ms) {
  var diff = ms - Date.now();
  if (diff <= 0) return 'Expired';
  var h = Math.floor(diff / 3600000);
  var m = Math.floor((diff % 3600000) / 60000);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

function stars(rating) {
  var n = Math.round(Number(rating) || 5);
  return '&#11088; ' + Number(rating || 5).toFixed(1);
}

function getNick() {
  if (!_nick) {
    var n = prompt('Unesi nickname (bez registracije):');
    if (!n || !n.trim()) return null;
    _nick = n.trim().replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 20) || 'user' + Date.now();
    localStorage.setItem('sato_nick', _nick);
    fetch('/api/user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: _nick }) });
    updateNickBar();
  }
  return _nick;
}

function changeNick() {
  var n = prompt('Novi nickname:', _nick);
  if (!n || !n.trim()) return;
  _nick = n.trim().replace(/[^a-zA-Z0-9_\-]/g, '').slice(0, 20);
  localStorage.setItem('sato_nick', _nick);
  fetch('/api/user', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: _nick }) });
  updateNickBar();
}

function updateNickBar() {
  var bar = document.getElementById('nick-bar');
  if (_nick) {
    bar.style.display = 'flex';
    document.getElementById('nick-display').textContent = _nick;
    loadBalance();
  } else {
    bar.style.display = 'none';
  }
}

async function loadBalance() {
  if (!_nick) return;
  var r = await fetch('/api/user/' + _nick);
  if (!r.ok) return;
  var d = await r.json();
  document.getElementById('bal-display').textContent = d.balance_sats || 0;
}

function switchTab(name) {
  _activeTab = name;
  var tabs = ['swap','lend','tasks','predict','data','profile','admin'];
  tabs.forEach(function(t) {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    var btn = document.getElementById('nav-' + t);
    if (btn) btn.classList.toggle('active', t === name);
  });
  if (name === 'swap') loadSwap();
  else if (name === 'lend') loadLoans();
  else if (name === 'tasks') loadTasks();
  else if (name === 'predict') loadPredictions();
  else if (name === 'data') loadData();
  else if (name === 'profile') loadProfile();
}

// ---- ASSETS ----
async function loadAssets() {
  var r = await fetch('/api/assets');
  _assets = await r.json();
  return _assets;
}

function assetOptions(selected) {
  return _assets.map(function(a) {
    return '<option value="' + esc(a.id) + '"' + (a.id === selected ? ' selected' : '') + '>' + esc(a.name) + (a.symbol ? ' (' + esc(a.symbol) + ')' : '') + '</option>';
  }).join('');
}

// ---- SWAP ----
var _swapData = [];
async function loadSwap() {
  var r = await fetch('/api/listings?type=' + _swapFilter);
  _swapData = await r.json();
  renderSwap();
}

function setSwapFilter(btn) {
  _swapFilter = btn.dataset.filter;
  document.querySelectorAll('.filter-bar button').forEach(function(b) { b.classList.remove('active'); });
  btn.classList.add('active');
  loadSwap();
}

function renderSwap() {
  var el = document.getElementById('swap-list');
  if (!_swapData.length) { el.innerHTML = '<p class="muted">' + t('no_listings') + '</p>'; return; }
  var h = '<div class="card-grid">';
  _swapData.forEach(function(l) {
    h += '<div class="card">';
    h += '<div class="row" style="margin-bottom:8px">';
    h += '<div><span class="asset-chip">&#128197; ' + esc(l.offer_name || l.offer_asset) + '</span>';
    h += '<span class="swap-arrow">&#8594;</span>';
    h += '<span class="asset-chip">&#128197; ' + esc(l.want_name || l.want_asset) + '</span></div>';
    h += '<span class="badge badge-active">active</span>';
    h += '</div>';
    h += '<div class="row" style="margin-bottom:6px">';
    h += '<div><span style="font-size:1.1em;font-weight:700;color:#ff5500;">' + esc(l.offer_amount) + '</span>';
    h += ' <span class="muted">' + esc(l.offer_asset.toUpperCase()) + '</span>';
    h += ' <span class="muted">za</span> ';
    h += '<span style="font-size:1.1em;font-weight:700;">' + esc(l.want_amount) + '</span>';
    h += ' <span class="muted">' + esc(l.want_asset.toUpperCase()) + '</span></div>';
    h += '</div>';
    if (l.description) h += '<p class="muted" style="margin-bottom:6px;font-size:0.85em;">' + esc(l.description) + '</p>';
    h += '<div class="row">';
    h += '<span class="muted" style="font-size:0.78em;">' + stars(l.rating) + (l.trusted ? ' <span class="badge badge-trusted">&#9733; TRUSTED</span>' : '') + ' @' + esc(l.seller_id) + '</span>';
    h += '<button class="btn btn-sm" data-lid="' + esc(l.id) + '" onclick="acceptSwap(this.dataset.lid)">' + t('btn_trade') + '</button>';
    h += '</div></div>';
  });
  h += '</div>';
  el.innerHTML = h;
}

async function acceptSwap(listingId) {
  var nick = getNick();
  if (!nick) return;
  setStatus('Kreiranje transakcije...', false);
  var r = await fetch('/api/swap', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ listingId: listingId, buyerId: nick }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  if (d.manual) {
    setStatus('Manuelna razmena kreirana! Kontaktiraj prodavca u chatu.', false);
    openChat(d.txId, 'swap');
  } else {
    showPaymentModal(d.payment_request, d.qr, d.checkout_url, d.txId, 'swap');
  }
}

function showNewListingModal() {
  if (!_assets.length) { setStatus('Ucitavanje asseta...', false); return; }
  var h = '<h3>&#128257; Novi Swap Oglas</h3>';
  h += '<div class="two-col"><div><label class="muted">Nudim (asset)</label><select id="m-offer-asset">' + assetOptions('sats') + '</select></div>';
  h += '<div><label class="muted">Nudim (kolicina)</label><input id="m-offer-amt" type="number" min="0.000001" step="any" placeholder="npr. 10000"></div></div>';
  h += '<div class="two-col"><div><label class="muted">Zelim (asset)</label><select id="m-want-asset">' + assetOptions('btc') + '</select></div>';
  h += '<div><label class="muted">Zelim (kolicina)</label><input id="m-want-amt" type="number" min="0.000001" step="any" placeholder="npr. 0.0005"></div></div>';
  h += '<label class="muted">Opis (opciono)</label><textarea id="m-desc" placeholder="Detalji razmene..."></textarea>';
  h += '<button class="btn" style="width:100%" onclick="submitListing()">&#9889; Objavi Oglas</button>';
  showOverlay(h);
}

async function submitListing() {
  var nick = getNick();
  if (!nick) return;
  var offerAsset = document.getElementById('m-offer-asset').value;
  var offerAmt = document.getElementById('m-offer-amt').value;
  var wantAsset = document.getElementById('m-want-asset').value;
  var wantAmt = document.getElementById('m-want-amt').value;
  var desc = document.getElementById('m-desc').value;
  if (!offerAmt || !wantAmt) return setStatus('Unesi kolicine.', true);
  var r = await fetch('/api/listings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sellerId: nick, offerAsset: offerAsset, offerAmount: offerAmt, wantAsset: wantAsset, wantAmount: wantAmt, description: desc }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  closeOverlay();
  setStatus('Oglas objavljen!', false);
  loadSwap();
}

// ---- LENDING ----
async function loadLoans() {
  var r = await fetch('/api/loans');
  var data = await r.json();
  var el = document.getElementById('loan-list');
  if (!data.length) { el.innerHTML = '<p class="muted">' + t('no_loans') + '</p>'; return; }
  var h = '<div class="card-grid">';
  data.forEach(function(l) {
    h += '<div class="card">';
    h += '<div class="row" style="margin-bottom:6px"><h3>&#128176; ' + esc(l.amount_sats) + ' sats</h3><span class="badge badge-open">open</span></div>';
    h += '<div class="muted" style="margin-bottom:4px">' + t('interest') + ': <span style="color:#facc15">+' + esc(l.interest_sats) + ' sats</span></div>';
    h += '<div class="muted" style="margin-bottom:4px">' + t('term') + ': <strong>' + esc(l.duration_hours) + 'h</strong></div>';
    if (l.collateral) h += '<div class="muted" style="margin-bottom:8px;font-size:0.82em;">' + t('collateral') + ': ' + esc(l.collateral) + '</div>';
    h += '<div class="row"><span class="muted" style="font-size:0.78em;">@' + esc(l.lender_id) + '</span>';
    h += '<button class="btn btn-sm" data-lid="' + esc(l.id) + '" onclick="takeLoan(this.dataset.lid)">' + t('btn_take_loan') + '</button>';
    h += '</div></div>';
  });
  h += '</div>';
  el.innerHTML = h;
}

async function takeLoan(loanId) {
  var nick = getNick();
  if (!nick) return;
  if (!confirm('Uzeti zajam? Vrati se u roku!')) return;
  var r = await fetch('/api/loans/' + loanId + '/take', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ borrowerId: nick }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  setStatus('Zajam odobren! Sats dodati na balance. Rok: ' + fmtTime(d.dueAt), false);
  loadBalance(); loadLoans();
}

function showNewLoanModal() {
  var h = '<h3>&#128176; Ponudi P2P Zajam</h3>';
  h += '<p class="muted" style="margin-bottom:10px;font-size:0.85em;">Sats se uzimaju s tvog balansa i drze u escrow-u.</p>';
  h += '<div class="two-col"><div><label class="muted">Iznos (sats)</label><input id="m-loan-amt" type="number" placeholder="10000"></div>';
  h += '<div><label class="muted">Kamata (sats)</label><input id="m-loan-int" type="number" placeholder="500"></div></div>';
  h += '<label class="muted">Rok (sati)</label><input id="m-loan-dur" type="number" placeholder="24">';
  h += '<label class="muted">Kolateral (opis sta borrower nudi kao garanciju)</label>';
  h += '<textarea id="m-loan-col" placeholder="npr. BTC adresa, IG profil, dokument..."></textarea>';
  h += '<button class="btn" style="width:100%" onclick="submitLoan()">&#9889; Ponudi Zajam</button>';
  showOverlay(h);
}

async function submitLoan() {
  var nick = getNick();
  if (!nick) return;
  var amt = document.getElementById('m-loan-amt').value;
  var intr = document.getElementById('m-loan-int').value;
  var dur = document.getElementById('m-loan-dur').value;
  var col = document.getElementById('m-loan-col').value;
  if (!amt || !intr || !dur) return setStatus('Popuni sva polja.', true);
  var r = await fetch('/api/loans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lenderId: nick, amountSats: Number(amt), interestSats: Number(intr), durationHours: Number(dur), collateral: col }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  closeOverlay(); setStatus('Ponuda zajma objavljena!', false); loadLoans(); loadBalance();
}

// ---- TASKS ----
async function loadTasks() {
  var r = await fetch('/api/tasks');
  var data = await r.json();
  var el = document.getElementById('task-list');
  if (!data.length) { el.innerHTML = '<p class="muted">' + t('no_tasks') + '</p>'; return; }
  var h = '<div class="card-grid">';
  data.forEach(function(t) {
    h += '<div class="card">';
    h += '<div class="row" style="margin-bottom:6px"><h3>' + esc(t.title) + '</h3><span class="badge badge-' + esc(t.status) + '">' + esc(t.status) + '</span></div>';
    h += '<p style="font-size:0.88em;margin-bottom:8px;">' + esc(t.description) + '</p>';
    h += '<div class="muted" style="margin-bottom:4px">Nagrada: <span style="color:#4ade80;font-weight:700;">+' + esc(t.reward_sats) + ' sats</span></div>';
    if (t.proof_required) h += '<div class="muted" style="font-size:0.82em;margin-bottom:6px;">Dokaz: ' + esc(t.proof_required) + '</div>';
    h += '<div class="row"><span class="muted" style="font-size:0.78em;">@' + esc(t.poster_id) + (t.worker_id ? ' &#8594; @' + esc(t.worker_id) : '') + '</span>';
    if (t.status === 'open') {
      h += '<button class="btn btn-sm" data-tid="' + esc(t.id) + '" onclick="takeTask(this.dataset.tid)">' + t('btn_take_task') + '</button>';
    } else if (t.status === 'taken') {
      h += '<button class="btn btn-sm btn-ghost" data-tid="' + esc(t.id) + '" onclick="submitTaskProof(this.dataset.tid)">' + t('btn_submit_proof') + '</button>';
    } else if (t.status === 'review') {
      h += '<button class="btn btn-sm btn-success" data-tid="' + esc(t.id) + '" onclick="approveTask(this.dataset.tid)">' + t('btn_approve') + '</button>';
      h += ' <button class="btn btn-sm btn-danger" data-tid="' + esc(t.id) + '" onclick="disputeTask(this.dataset.tid)">' + t('btn_dispute') + '</button>';
    }
    h += '</div>';
    if (t.proof_submission && t.status === 'review') h += '<div style="margin-top:8px;padding:8px;background:#080c12;border-radius:6px;font-size:0.82em;">Dokaz: ' + esc(t.proof_submission) + '</div>';
    h += '</div>';
  });
  h += '</div>';
  el.innerHTML = h;
}

async function takeTask(taskId) {
  var nick = getNick();
  if (!nick) return;
  var r = await fetch('/api/tasks/' + taskId + '/take', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: nick }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  setStatus('Task prihvacen! Izvrsi i podnesi dokaz.', false); loadTasks();
}

async function submitTaskProof(taskId) {
  var nick = getNick();
  if (!nick) return;
  var proof = prompt('Unesi dokaz izvrsenja:');
  if (!proof) return;
  var r = await fetch('/api/tasks/' + taskId + '/submit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ workerId: nick, proof: proof }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  setStatus('Dokaz poslan! Cekaj odobrenje.', false); loadTasks();
}

async function approveTask(taskId) {
  var nick = getNick();
  if (!nick) return;
  var r = await fetch('/api/tasks/' + taskId + '/approve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posterId: nick }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  setStatus('Task odobren! Worker placen.', false); loadTasks(); loadBalance();
}

async function disputeTask(taskId) {
  var nick = getNick();
  if (!nick) return;
  var reason = prompt('Razlog spora:');
  if (!reason) return;
  await fetch('/api/tasks/' + taskId + '/dispute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: nick, reason: reason }) });
  setStatus('Spor otvoren. Admin ce pregledati.', false); loadTasks();
}

function showNewTaskModal() {
  var h = '<h3>&#9989; Postavi Task</h3>';
  h += '<p class="muted" style="margin-bottom:10px;font-size:0.85em;">Nagrada se placa unapred putem Lightning-a i drzi u escrow-u.</p>';
  h += '<label class="muted">Naziv taska</label><input id="m-task-title" placeholder="npr. Prevedi tekst 500 rijeci">';
  h += '<label class="muted">Opis</label><textarea id="m-task-desc" placeholder="Detaljan opis sta treba uraditi..."></textarea>';
  h += '<div class="two-col"><div><label class="muted">Nagrada (sats)</label><input id="m-task-reward" type="number" placeholder="2000"></div>';
  h += '<div><label class="muted">Dokaz (sta treba dostaviti)</label><input id="m-task-proof" placeholder="screenshot, link..."></div></div>';
  h += '<button class="btn" style="width:100%" onclick="submitNewTask()">&#9889; Postavi Task (plati nagradu unapred)</button>';
  showOverlay(h);
}

async function submitNewTask() {
  var nick = getNick();
  if (!nick) return;
  var title = document.getElementById('m-task-title').value;
  var desc = document.getElementById('m-task-desc').value;
  var reward = document.getElementById('m-task-reward').value;
  var proof = document.getElementById('m-task-proof').value;
  if (!title || !desc || !reward) return setStatus('Popuni sva polja.', true);
  var r = await fetch('/api/tasks', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ posterId: nick, title: title, description: desc, rewardSats: Number(reward), proofRequired: proof }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  closeOverlay();
  showPaymentModal(d.payment_request, d.qr, d.checkout_url, d.id, 'task');
}

// ---- PREDICTIONS ----
async function loadPredictions() {
  var r = await fetch('/api/predictions');
  var data = await r.json();
  var el = document.getElementById('predict-list');
  if (!data.length) { el.innerHTML = '<p class="muted">' + t('no_preds') + '</p>'; return; }
  var h = '<div class="card-grid">';
  data.forEach(function(p) {
    h += '<div class="card">';
    h += '<div class="row" style="margin-bottom:6px">';
    h += '<h3>' + esc(p.asset) + ' <span class="pred-chip ' + esc(p.direction) + '">' + (p.direction === 'above' ? '&#8599; iznad' : '&#8600; ispod') + ' $' + esc(p.target_price) + '</span></h3>';
    h += '<span class="badge badge-' + esc(p.status) + '">' + esc(p.status) + '</span></div>';
    h += '<div class="muted" style="margin-bottom:4px">Ulazni iznos: <span style="color:#ff5500;font-weight:700;">' + esc(p.stake_sats) + ' sats</span> svaka strana</div>';
    h += '<div class="muted" style="margin-bottom:4px">Razresava: ' + fmtTime(p.resolve_at) + ' <span style="color:#facc15">(' + timeTo(p.resolve_at) + ')</span></div>';
    h += '<div class="row"><span class="muted" style="font-size:0.78em;">Creator: @' + esc(p.creator_id) + (p.challenger_id ? ' vs @' + esc(p.challenger_id) : '') + '</span>';
    if (p.status === 'open') {
      h += '<button class="btn btn-sm" data-pid="' + esc(p.id) + '" onclick="challengePrediction(this.dataset.pid)">' + t('btn_challenge') + '</button>';
    } else if (p.status === 'resolved') {
      h += '<span style="color:#4ade80">&#127942; Winner: @' + esc(p.winner_id || '?') + '</span>';
    }
    h += '</div></div>';
  });
  h += '</div>';
  el.innerHTML = h;
}

async function challengePrediction(predId) {
  var nick = getNick();
  if (!nick) return;
  var r = await fetch('/api/predictions/' + predId + '/challenge', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ challengerId: nick }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  showPaymentModal(d.payment_request, d.qr, d.checkout_url, predId, 'prediction');
}

function showNewPredictModal() {
  var cryptoAssets = _assets.filter(function(a) { return a.type === 'crypto' && ['BTC','ETH','LTC','BNB','USDT','TRX','SOL'].indexOf(a.symbol) >= 0; });
  var opts = cryptoAssets.map(function(a) { return '<option value="' + esc(a.symbol) + '">' + esc(a.symbol) + ' - ' + esc(a.name) + '</option>'; }).join('');
  if (!opts) opts = '<option value="BTC">BTC - Bitcoin</option><option value="ETH">ETH - Ethereum</option>';
  var h = '<h3>&#127919; Kreiraj Price Prediction</h3>';
  h += '<div class="two-col"><div><label class="muted">Asset</label><select id="m-pred-asset">' + opts + '</select></div>';
  h += '<div><label class="muted">Ciljana cijena ($)</label><input id="m-pred-price" type="number" placeholder="100000"></div></div>';
  h += '<label class="muted">Smjer</label>';
  h += '<select id="m-pred-dir"><option value="above">&#8599; Iznad cilje (YES)</option><option value="below">&#8600; Ispod cilje (NO)</option></select>';
  h += '<div class="two-col"><div><label class="muted">Razresava za (minuta)</label><input id="m-pred-min" type="number" placeholder="60"></div>';
  h += '<div><label class="muted">Ulazni iznos (sats)</label><input id="m-pred-stake" type="number" placeholder="5000"></div></div>';
  h += '<button class="btn" style="width:100%" onclick="submitPrediction()">&#9889; Kreiraj (plati stake)</button>';
  showOverlay(h);
}

async function submitPrediction() {
  var nick = getNick();
  if (!nick) return;
  var asset = document.getElementById('m-pred-asset').value;
  var price = document.getElementById('m-pred-price').value;
  var dir = document.getElementById('m-pred-dir').value;
  var min = document.getElementById('m-pred-min').value;
  var stake = document.getElementById('m-pred-stake').value;
  if (!asset || !price || !dir || !min || !stake) return setStatus('Popuni sva polja.', true);
  var r = await fetch('/api/predictions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ creatorId: nick, asset: asset, targetPrice: price, direction: dir, resolvesInMinutes: min, stakeSats: Number(stake) }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  closeOverlay();
  showPaymentModal(d.payment_request, d.qr, d.checkout_url, d.id, 'prediction');
}

// ---- DATA MARKET ----
async function loadData() {
  var r = await fetch('/api/data');
  var data = await r.json();
  var el = document.getElementById('data-list');
  if (!data.length) { el.innerHTML = '<p class="muted">' + t('no_data') + '</p>'; return; }
  var h = '<div class="card-grid">';
  data.forEach(function(d) {
    var typeIcon = { proxy:'&#127758;', vpn:'&#128274;', api_key:'&#128273;', account:'&#128100;', other:'&#128190;' };
    h += '<div class="card">';
    h += '<div class="row" style="margin-bottom:6px"><h3>' + (typeIcon[d.type] || '&#128190;') + ' ' + esc(d.title) + '</h3><span class="badge badge-active">' + esc(d.type) + '</span></div>';
    h += '<p style="font-size:0.85em;margin-bottom:8px;">' + esc(d.description) + '</p>';
    h += '<div class="muted" style="margin-bottom:6px">Cijena: <span style="color:#ff5500;font-weight:700;">' + esc(d.price_sats) + ' sats</span>';
    if (d.duration_hours) h += ' za ' + esc(d.duration_hours) + 'h';
    h += '</div>';
    h += '<div class="row"><span class="muted" style="font-size:0.78em;">@' + esc(d.seller_id) + '</span>';
    h += '<button class="btn btn-sm" data-did="' + esc(d.id) + '" onclick="buyData(this.dataset.did)">' + t('btn_buy') + '</button>';
    h += '</div></div>';
  });
  h += '</div>';
  el.innerHTML = h;
}

async function buyData(dataId) {
  var nick = getNick();
  if (!nick) return;
  var r = await fetch('/api/data/' + dataId + '/buy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buyerId: nick }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  showPaymentModal(d.payment_request, d.qr, d.checkout_url, d.txId, 'data');
}

function showNewDataModal() {
  var h = '<h3>&#128274; Prodaj Data/Pristup</h3>';
  h += '<label class="muted">Naziv</label><input id="m-data-title" placeholder="npr. Residential Proxy UK">';
  h += '<label class="muted">Tip</label>';
  h += '<select id="m-data-type"><option value="proxy">Proxy</option><option value="vpn">VPN</option><option value="api_key">API Key</option><option value="account">Account</option><option value="other">Ostalo</option></select>';
  h += '<label class="muted">Opis</label><textarea id="m-data-desc" placeholder="Detalji pristupa..."></textarea>';
  h += '<div class="two-col"><div><label class="muted">Cijena (sats)</label><input id="m-data-price" type="number" placeholder="1000"></div>';
  h += '<div><label class="muted">Trajanje (sati, opciono)</label><input id="m-data-dur" type="number" placeholder="24"></div></div>';
  h += '<button class="btn" style="width:100%" onclick="submitData()">&#9889; Objavi Ponudu</button>';
  showOverlay(h);
}

async function submitData() {
  var nick = getNick();
  if (!nick) return;
  var title = document.getElementById('m-data-title').value;
  var type = document.getElementById('m-data-type').value;
  var desc = document.getElementById('m-data-desc').value;
  var price = document.getElementById('m-data-price').value;
  var dur = document.getElementById('m-data-dur').value;
  if (!title || !desc || !price) return setStatus('Popuni sva polja.', true);
  var r = await fetch('/api/data', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sellerId: nick, title: title, description: desc, type: type, priceSats: Number(price), durationHours: dur ? Number(dur) : null }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  closeOverlay(); setStatus('Ponuda objavljena!', false); loadData();
}

// ---- PROFILE ----
async function loadProfile() {
  var nick = getNick();
  if (!nick) return;
  var el = document.getElementById('profile-content');
  var r = await fetch('/api/user/' + nick);
  if (!r.ok) { el.innerHTML = '<p class="muted">Greska pri ucitavanju profila.</p>'; return; }
  var u = await r.json();
  var h = '<div class="card">';
  h += '<div class="row" style="margin-bottom:10px"><div><h3>@' + esc(u.id) + (u.trusted ? ' <span class="badge badge-trusted">&#9733; TRUSTED</span>' : '') + '</h3>';
  h += '<span class="muted">' + stars(u.rating) + ' &bull; ' + esc(u.total_trades) + ' trades</span></div>';
  h += '<span style="font-size:1.3em;font-weight:700;color:#ff5500;">' + esc(u.balance_sats) + ' <span class="muted" style="font-size:0.6em;">sats</span></span></div>';
  h += '<div style="display:flex;gap:8px;flex-wrap:wrap">';
  h += '<button class="btn btn-sm" onclick="showDepositModal()">+ Deposit</button>';
  h += '<button class="btn btn-sm btn-ghost" onclick="showWithdrawModal()">- Withdraw</button>';
  h += '</div></div>';

  if (u.listings && u.listings.length) {
    h += '<h3 style="margin-bottom:8px">Moji aktivni oglasi</h3>';
    u.listings.forEach(function(l) {
      h += '<div class="card">';
      h += '<div class="row"><span>' + esc(l.offer_amount) + ' ' + esc(l.offer_asset.toUpperCase()) + ' &#8594; ' + esc(l.want_amount) + ' ' + esc(l.want_asset.toUpperCase()) + '</span>';
      h += '<button class="btn btn-sm btn-danger" data-lid="' + esc(l.id) + '" onclick="removeListing(this.dataset.lid)">Ukloni</button>';
      h += '</div></div>';
    });
  }

  if (u.ratings && u.ratings.length) {
    h += '<h3 style="margin-top:12px;margin-bottom:8px">Ocjene</h3>';
    u.ratings.forEach(function(r) {
      h += '<div class="card"><div class="row"><span>' + stars(r.score) + ' od @' + esc(r.from_user) + '</span><span class="muted">' + fmtTime(r.created_at) + '</span></div></div>';
    });
  }
  el.innerHTML = h;
}

async function removeListing(listingId) {
  var nick = getNick();
  if (!nick) return;
  if (!confirm('Ukloniti oglas?')) return;
  await fetch('/api/listings/' + listingId, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sellerId: nick }) });
  setStatus('Oglas uklonjen.', false); loadProfile(); if (_activeTab === 'swap') loadSwap();
}

// ---- DEPOSIT / WITHDRAW ----
function showDepositModal() {
  var nick = getNick();
  if (!nick) return;
  var h = '<h3>+ Deposit Sats</h3>';
  h += '<label class="muted">Iznos (sats)</label><input id="m-dep-amt" type="number" placeholder="10000">';
  h += '<button class="btn" style="width:100%" onclick="submitDeposit()">&#9889; Generiraj Invoice</button>';
  h += '<div id="m-dep-result" style="margin-top:12px;"></div>';
  showOverlay(h);
}

async function submitDeposit() {
  var nick = getNick();
  if (!nick) return;
  var amt = document.getElementById('m-dep-amt').value;
  if (!amt || amt < 1) return setStatus('Unesi iznos.', true);
  var r = await fetch('/api/deposit', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: nick, amountSats: Number(amt) }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  var el = document.getElementById('m-dep-result');
  var h = '<p class="muted" style="margin-bottom:8px">Skeniraj QR ili kopiraj invoice:</p>';
  if (d.qr) h += '<img src="' + esc(d.qr) + '" style="width:180px;display:block;margin-bottom:8px;">';
  if (d.payment_request) h += '<textarea readonly style="font-size:0.7em;height:60px;width:100%;background:#080c12;color:#facc15;border:1px solid #1e2d40;border-radius:6px;padding:6px;">' + esc(d.payment_request) + '</textarea>';
  if (d.checkout_url) h += '<a href="' + esc(d.checkout_url) + '" target="_blank" class="btn btn-sm btn-ghost" style="margin-top:6px;display:inline-block;">Otvori Wallet App</a>';
  el.innerHTML = h;
}

function showWithdrawModal() {
  var nick = getNick();
  if (!nick) return;
  var h = '<h3>- Withdraw Sats</h3>';
  h += '<label class="muted">Lightning Adresa</label><input id="m-wd-addr" placeholder="user@walletofsatoshi.com">';
  h += '<label class="muted">Iznos (sats)</label><input id="m-wd-amt" type="number" placeholder="5000">';
  h += '<button class="btn" style="width:100%" onclick="submitWithdraw()">&#9889; Povuci</button>';
  showOverlay(h);
}

async function submitWithdraw() {
  var nick = getNick();
  if (!nick) return;
  var addr = document.getElementById('m-wd-addr').value;
  var amt = document.getElementById('m-wd-amt').value;
  if (!addr || !amt) return setStatus('Popuni sva polja.', true);
  var r = await fetch('/api/withdraw', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: nick, lightningAddress: addr, amountSats: Number(amt) }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  closeOverlay(); setStatus('Povuceno ' + amt + ' sats!', false); loadBalance();
}

// ---- PAYMENT MODAL ----
function showPaymentModal(pr, qr, checkoutUrl, refId, refType) {
  var h = '<h3>&#9889; Plati via Lightning</h3>';
  if (qr) h += '<img src="' + esc(qr) + '" style="width:200px;display:block;margin:10px auto;">';
  if (pr) h += '<textarea readonly style="font-size:0.7em;height:60px;width:100%;background:#080c12;color:#facc15;border:1px solid #1e2d40;border-radius:6px;padding:6px;">' + esc(pr) + '</textarea>';
  if (checkoutUrl) h += '<a href="' + esc(checkoutUrl) + '" target="_blank" class="btn btn-sm btn-ghost" style="margin-top:6px;display:inline-block;">Otvori Wallet App</a>';
  h += '<p class="muted" style="margin-top:10px;font-size:0.82em;">&#128260; Auto-provjera svake 3 sekunde...</p>';
  h += '<div id="pay-status" style="margin-top:6px;"></div>';
  showOverlay(h);
  startPayPoll(refId, refType);
}

function startPayPoll(refId, refType) {
  if (_payPollTimer) clearInterval(_payPollTimer);
  var polls = 0;
  _payPollTimer = setInterval(async function() {
    polls++;
    if (polls > 60) { clearInterval(_payPollTimer); return; }
    var url = refType === 'task' ? '/api/tasks/' + refId : (refType === 'prediction' ? '/api/predictions/' + refId : '/api/tx/' + refId);
    if (refType === 'task' || refType === 'prediction') {
      var r2 = await fetch(refType === 'task' ? '/api/tasks/' : '/api/predictions/');
      // just check status change
    }
    var r = await fetch(refType === 'swap' ? '/api/tx/' + refId : url);
    if (!r.ok) return;
    var d = await r.json();
    var paid = d.status && (d.status === 'paid' || d.status === 'open' || d.status === 'active');
    if (paid) {
      clearInterval(_payPollTimer);
      var el = document.getElementById('pay-status');
      if (el) el.innerHTML = '<span style="color:#4ade80;font-weight:700;">&#10003; Placeno! Transakcija aktivna.</span>';
      setStatus('Placanje potvrdjeno!', false);
      setTimeout(function() { closeOverlay(); if (_activeTab === 'swap') loadSwap(); else if (_activeTab === 'tasks') loadTasks(); else if (_activeTab === 'predict') loadPredictions(); loadBalance(); }, 2000);
    }
  }, 3000);
}

// ---- CHAT ----
function openChat(refId, refType) {
  _chatRefId = refId;
  _chatRefType = refType;
  var nick = getNick();
  var h = '<h3>&#128172; Chat - ' + esc(refId.slice(0,8)) + '...</h3>';
  h += '<div id="chat-msgs" style="height:300px;overflow-y:auto;margin-bottom:10px;"></div>';
  h += '<div class="chat-input-row"><input id="chat-inp" placeholder="' + t('chat_placeholder') + '" onkeydown="chatKey(event)"><button class="btn btn-sm" onclick="sendChatMsg()">&#9658;</button></div>';
  if (_activeTab === 'swap') {
    h += '<div style="margin-top:10px;display:flex;gap:6px;flex-wrap:wrap">';
    h += '<button class="btn btn-sm btn-success" data-tid="' + esc(refId) + '" onclick="confirmSwap(this.dataset.tid)">' + t('btn_confirm') + '</button>';
    h += '<button class="btn btn-sm btn-danger" data-tid="' + esc(refId) + '" onclick="openDispute(this.dataset.tid)">' + t('btn_open_dispute') + '</button>';
    h += '</div>';
  }
  document.getElementById('chat-content').innerHTML = h;
  document.getElementById('chat-overlay').classList.add('open');
  loadChatMsgs();
  if (_chatTimer) clearInterval(_chatTimer);
  _chatTimer = setInterval(loadChatMsgs, 3000);
}

async function loadChatMsgs() {
  if (!_chatRefId) return;
  var r = await fetch('/api/chat/' + _chatRefId);
  if (!r.ok) return;
  var msgs = await r.json();
  var nick = _nick;
  var el = document.getElementById('chat-msgs');
  if (!el) return;
  var h = '';
  if (!msgs.length) h = '<p class="muted" style="padding:10px;text-align:center;">' + t('no_msgs') + '</p>';
  msgs.forEach(function(m) {
    var mine = m.sender_id === nick;
    h += '<div class="chat-msg ' + (mine ? 'mine' : 'other') + '">';
    h += '<div class="sender">@' + esc(m.sender_id) + '</div>';
    h += esc(m.content);
    h += '</div>';
  });
  el.innerHTML = h;
  el.scrollTop = el.scrollHeight;
}

function chatKey(e) { if (e.key === 'Enter') sendChatMsg(); }

async function sendChatMsg() {
  var nick = getNick();
  if (!nick || !_chatRefId) return;
  var inp = document.getElementById('chat-inp');
  var content = inp.value.trim();
  if (!content) return;
  inp.value = '';
  await fetch('/api/chat/' + _chatRefId, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ senderId: nick, content: content, refType: _chatRefType }) });
  loadChatMsgs();
}

async function confirmSwap(txId) {
  var nick = getNick();
  if (!nick) return;
  if (!confirm('Potvrditi prijem? Sredstva idu prodavcu.')) return;
  var r = await fetch('/api/tx/' + txId + '/confirm', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ buyerId: nick }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  setStatus('Swap potvrdjeno! Sredstva oslobodjena.', false);
  closeChatOverlay(); loadSwap(); loadBalance();
}

async function openDispute(txId) {
  var nick = getNick();
  if (!nick) return;
  var reason = prompt('Razlog spora:');
  if (!reason) return;
  await fetch('/api/tx/' + txId + '/dispute', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ userId: nick, reason: reason }) });
  setStatus('Spor otvoren. Admin ce pregledati.', false);
  closeChatOverlay();
}

// ---- ADMIN ----
async function adminLogin() {
  _adminKey = document.getElementById('admin-key-inp').value;
  var r = await fetch('/api/admin/stats?adminKey=' + encodeURIComponent(_adminKey));
  if (!r.ok) { setStatus('Pogresni admin key.', true); return; }
  var stats = await r.json();
  document.getElementById('admin-content').style.display = 'block';
  loadAdminPanel(stats);
}

async function loadAdminPanel(stats) {
  var h = '<div class="card" style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:12px;text-align:center;">';
  h += '<div><div class="muted" style="font-size:0.8em">Users</div><div style="font-size:1.5em;font-weight:700">' + esc(stats.users) + '</div></div>';
  h += '<div><div class="muted" style="font-size:0.8em">Listings</div><div style="font-size:1.5em;font-weight:700">' + esc(stats.listings) + '</div></div>';
  h += '<div><div class="muted" style="font-size:0.8em">Revenue</div><div style="font-size:1.5em;font-weight:700;color:#ff5500">' + esc(stats.revenue_sats) + '</div><div class="muted" style="font-size:0.72em">sats</div></div>';
  h += '</div>';

  var r = await fetch('/api/admin/disputes?adminKey=' + encodeURIComponent(_adminKey));
  var disputes = await r.json();
  var allDisputes = (disputes.swaps || []).concat(disputes.loans || []).concat(disputes.tasks || []);

  h += '<h3 style="margin-bottom:8px">&#9888; Sporovi (' + allDisputes.length + ')</h3>';
  if (!allDisputes.length) h += '<p class="muted">Nema aktivnih sporova.</p>';
  allDisputes.forEach(function(d) {
    h += '<div class="card" style="border-color:#7f1d1d">';
    h += '<div class="row" style="margin-bottom:6px"><h3>' + esc(d.kind ? d.kind.toUpperCase() : 'TX') + ' #' + esc(d.id.slice(0,8)) + '</h3><span class="badge badge-disputed">disputed</span></div>';
    if (d.dispute_reason) h += '<p class="muted" style="margin-bottom:6px;font-size:0.85em;">' + esc(d.dispute_reason) + '</p>';
    if (d.proof_submission) h += '<p class="muted" style="margin-bottom:6px;font-size:0.85em;">Proof: ' + esc(d.proof_submission) + '</p>';
    h += '<div style="display:flex;gap:6px;flex-wrap:wrap">';
    var kind = d.kind || 'swap';
    if (kind === 'swap') {
      h += '<button class="btn btn-sm btn-success" data-id="' + esc(d.id) + '" data-t="swap" data-w="buyer" onclick="adminResolve(this)">&#10003; Buyer wins</button>';
      h += '<button class="btn btn-sm btn-danger" data-id="' + esc(d.id) + '" data-t="swap" data-w="seller" onclick="adminResolve(this)">&#10003; Seller wins</button>';
    } else if (kind === 'loan') {
      h += '<button class="btn btn-sm btn-success" data-id="' + esc(d.id) + '" data-t="loan" data-w="lender" onclick="adminResolve(this)">&#10003; Lender wins</button>';
      h += '<button class="btn btn-sm btn-danger" data-id="' + esc(d.id) + '" data-t="loan" data-w="borrower" onclick="adminResolve(this)">&#10003; Borrower wins</button>';
    } else {
      h += '<button class="btn btn-sm btn-success" data-id="' + esc(d.id) + '" data-t="task" data-w="worker" onclick="adminResolve(this)">&#10003; Worker wins</button>';
      h += '<button class="btn btn-sm btn-danger" data-id="' + esc(d.id) + '" data-t="task" data-w="poster" onclick="adminResolve(this)">&#10003; Poster wins</button>';
    }
    h += '</div></div>';
  });

  h += '<h3 style="margin-top:16px;margin-bottom:8px">&#128290; Assets</h3>';
  var ar = await fetch('/api/assets');
  var assets = await ar.json();
  h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:8px;margin-bottom:10px">';
  assets.forEach(function(a) {
    h += '<div class="card" style="padding:10px">';
    h += '<div class="row"><strong style="font-size:0.88em">' + esc(a.name) + '</strong>';
    h += '<label style="display:flex;align-items:center;gap:4px;cursor:pointer;font-size:0.8em;">';
    h += '<input type="checkbox" data-aid="' + esc(a.id) + '" ' + (a.active ? 'checked' : '') + ' onchange="toggleAsset(this)"> Active</label>';
    h += '</div></div>';
  });
  h += '</div>';
  h += '<button class="btn btn-sm btn-ghost" onclick="showAddAssetModal()">+ Dodaj novi asset</button>';

  document.getElementById('admin-content').innerHTML = h;
}

async function adminResolve(btn) {
  var id = btn.dataset.id;
  var type = btn.dataset.t;
  var winner = btn.dataset.w;
  if (!confirm('Rijesiti spor u korist: ' + winner + '?')) return;
  var r = await fetch('/api/admin/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminKey: _adminKey, id: id, winner: winner, type: type }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  setStatus('Spor rijesen!', false);
  adminLogin();
}

async function toggleAsset(cb) {
  await fetch('/api/admin/assets/' + cb.dataset.aid, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminKey: _adminKey, active: cb.checked }) });
}

function showAddAssetModal() {
  var h = '<h3>+ Dodaj Asset</h3>';
  h += '<label class="muted">Naziv</label><input id="m-ast-name" placeholder="npr. Dogecoin">';
  h += '<div class="two-col"><div><label class="muted">Tip</label><select id="m-ast-type"><option value="crypto">Crypto</option><option value="token">Token</option><option value="voucher">Voucher</option><option value="giftcard">Gift Card</option></select></div>';
  h += '<div><label class="muted">Simbol</label><input id="m-ast-sym" placeholder="DOGE"></div></div>';
  h += '<label class="muted">Contract Adresa (opciono, za ERC20/BEP20)</label><input id="m-ast-contract" placeholder="0x...">';
  h += '<div class="two-col"><div><label class="muted">Decimali</label><input id="m-ast-dec" type="number" value="18"></div>';
  h += '<div><label class="muted">Mreža</label><input id="m-ast-net" placeholder="ETH / BSC / TRX"></div></div>';
  h += '<button class="btn" style="width:100%" onclick="submitAddAsset()">+ Dodaj</button>';
  showOverlay(h);
}

async function submitAddAsset() {
  var name = document.getElementById('m-ast-name').value;
  var type = document.getElementById('m-ast-type').value;
  var sym = document.getElementById('m-ast-sym').value;
  var contract = document.getElementById('m-ast-contract').value;
  var dec = document.getElementById('m-ast-dec').value;
  var net = document.getElementById('m-ast-net').value;
  if (!name || !type) return setStatus('Unesi naziv i tip.', true);
  var r = await fetch('/api/admin/assets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ adminKey: _adminKey, name: name, type: type, symbol: sym, contractAddress: contract, decimals: Number(dec)||0, network: net }) });
  var d = await r.json();
  if (!r.ok) return setStatus(d.error || 'Greska.', true);
  closeOverlay(); setStatus('Asset dodan!', false); loadAssets();
}

// ---- OVERLAY UTILS ----
function showOverlay(content) {
  document.getElementById('overlay-content').innerHTML = content;
  document.getElementById('overlay').classList.add('open');
}
function closeOverlay() {
  document.getElementById('overlay').classList.remove('open');
  if (_payPollTimer) { clearInterval(_payPollTimer); _payPollTimer = null; }
}
function overlayBgClick(e) { if (e.target === document.getElementById('overlay')) closeOverlay(); }

function closeChatOverlay() {
  document.getElementById('chat-overlay').classList.remove('open');
  _chatRefId = '';
  if (_chatTimer) { clearInterval(_chatTimer); _chatTimer = null; }
}
function chatBgClick(e) { if (e.target === document.getElementById('chat-overlay')) closeChatOverlay(); }

// ---- INIT ----
(async function init() {
  applyTheme(_themeIdx);
  applyLang();
  updateNickBar();
  await loadAssets();
  loadSwap();
})();
</script>

<footer style='text-align:center;padding:24px 16px;border-top:1px solid #1e2d40;margin-top:24px;'>
  <div style='color:#64748b;font-size:0.82em;'>
    <strong style='color:#ff5500;'>&#9889; SATONERO</strong> &mdash; Micro P2P Market &mdash; All in Bitcoin Lightning
  </div>
  <div style='margin-top:6px;font-size:0.78em;color:#475569;'>
    Nemas registracije. Nema minimuma. Sve u satoshi.
  </div>
  <div style='margin-top:8px;'>
    <a id='footer-contact' href='mailto:__ADMIN_EMAIL__' style='color:#94a3b8;font-size:0.8em;text-decoration:none;'>&#9993; Kontakt / Support</a>
    &nbsp;&bull;&nbsp;
    <a id='footer-admin-link' href='#' onclick='switchTab("admin");return false;' style='color:#94a3b8;font-size:0.8em;'>&#9881; Admin</a>
  </div>
</footer>
</body>
</html>`;

// ---- SERVER ----
app.get('/', (req, res) => {
  const page = HTML.replace(/__ADMIN_EMAIL__/g, ADMIN_EMAIL);
  res.send(page);
});

app.get('/manifest.json', (req, res) => {
  res.json({
    name: 'SATONERO P2P Market',
    short_name: 'SATONERO',
    description: 'Micro P2P marketplace. Swap crypto, lend sats, earn on tasks, predict prices. No registration.',
    start_url: '/',
    display: 'standalone',
    background_color: '#0c0f14',
    theme_color: '#ff5500',
    lang: 'en',
    icons: [
      { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any maskable' }
    ],
    categories: ['finance', 'bitcoin', 'crypto']
  });
});

app.get('/icon.svg', (req, res) => {
  res.setHeader('Content-Type', 'image/svg+xml');
  res.send(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <rect width="100" height="100" rx="20" fill="#0c0f14"/>
  <text x="50" y="68" font-size="60" text-anchor="middle" fill="#ff5500">&#9889;</text>
</svg>`);
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

initDb().then(() => {
  app.listen(PORT, () => console.log('SATONERO running on port ' + PORT));
}).catch(e => { console.error('DB init failed:', e.message); process.exit(1); });
