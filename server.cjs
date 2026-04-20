require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

// Za SBP API pozive
const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

const app = express();
app.use(express.json());
app.use(express.static('public'));

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

const genId = () => crypto.randomBytes(8).toString('hex');

// --- DATABASE INIT ---
async function initDb() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, symbol TEXT,
        active BOOLEAN DEFAULT true, created_at BIGINT
      );
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT, balance_sats INT DEFAULT 0, rating NUMERIC DEFAULT 5.0,
        total_trades INT DEFAULT 0, trusted BOOLEAN DEFAULT false, created_at BIGINT
      );
      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY, seller_id TEXT NOT NULL, offer_asset TEXT NOT NULL, offer_amount NUMERIC NOT NULL,
        want_asset TEXT NOT NULL, want_amount NUMERIC NOT NULL, description TEXT, status TEXT DEFAULT 'active', created_at BIGINT
      );
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY, listing_id TEXT, buyer_id TEXT, seller_id TEXT, offer_asset TEXT,
        offer_amount NUMERIC, want_asset TEXT, want_amount NUMERIC, status TEXT DEFAULT 'pending', 
        invoice_id TEXT, payment_request TEXT, created_at BIGINT, paid_at BIGINT, released_at BIGINT
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, ref_id TEXT NOT NULL, ref_type TEXT NOT NULL,
        sender_id TEXT NOT NULL, content TEXT NOT NULL, created_at BIGINT
      );
    `);
    
    const initialAssets = [
      ['sats', 'Satoshi', 'crypto'], 
      ['btc', 'Bitcoin', 'crypto'], 
      ['paysafe', 'Paysafecard', 'voucher'],
      ['steam', 'Steam Gift Card', 'giftcard']
    ];
    for (let a of initialAssets) {
      await client.query('INSERT INTO assets (id, name, type, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [...a, Date.now()]);
    }
    console.log("✅ Baza i tabele su spremne.");
  } catch (err) {
    console.error("Greška u bazi:", err);
  } finally { client.release(); }
}
initDb();

// --- API RUTE ---

// ASSETS
app.get('/api/assets', async (req, res) => {
  const r = await pool.query('SELECT * FROM assets WHERE active = true');
  res.json(r.rows);
});

// LISTINGS
app.get('/api/listings', async (req, res) => {
  const r = await pool.query(`
    SELECT l.*, a1.name as offer_name, a2.name as want_name 
    FROM listings l 
    JOIN assets a1 ON l.offer_asset = a1.id 
    JOIN assets a2 ON l.want_asset = a2.id 
    WHERE l.status = 'active' ORDER BY l.created_at DESC
  `);
  res.json(r.rows);
});

app.post('/api/listings', async (req, res) => {
  const { sellerId, offerAsset, offerAmount, wantAsset, wantAmount, description, email } = req.body;
  const id = genId();
  try {
    await pool.query('INSERT INTO users (id, email, created_at) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [sellerId, email, Date.now()]);
    await pool.query('INSERT INTO listings (id, seller_id, offer_asset, offer_amount, want_asset, want_amount, description, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)', 
      [id, sellerId, offerAsset, offerAmount, wantAsset, wantAmount, description, Date.now()]);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// SWAP / TRANSAKCIJE
app.post('/api/swap', async (req, res) => {
  const { listingId, buyerId } = req.body;
  const txId = genId();
  try {
    const l = (await pool.query('SELECT * FROM listings WHERE id = $1', [listingId])).rows[0];
    let pr = null, invId = null;

    if (l.offer_asset === 'sats') {
      const sbp = await fetch('https://api.swiss-bitcoin-pay.ch/charge', {
        method: 'POST',
        headers: { 'api-key': process.env.SBP_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: parseInt(l.offer_amount), unit: 'sat',
          description: `P2P:${txId}`, webhook: `${process.env.BASE_URL}/api/webhook/swap/${txId}`
        })
      });
      const sbpData = await sbp.json();
      pr = sbpData.paymentRequest;
      invId = sbpData.id;
    }

    await pool.query('INSERT INTO transactions (id, listing_id, buyer_id, seller_id, offer_asset, offer_amount, want_asset, want_amount, status, payment_request, invoice_id, created_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)',
      [txId, listingId, buyerId, l.seller_id, l.offer_asset, l.offer_amount, l.want_asset, l.want_amount, pr ? 'pending' : 'paid', pr, invId, Date.now()]);
    
    res.json({ txId, paymentRequest: pr });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/tx/:txId', async (req, res) => {
  const r = await pool.query('SELECT * FROM transactions WHERE id = $1', [req.params.txId]);
  res.json(r.rows[0]);
});

// WEBHOOK
app.post('/api/webhook/swap/:txId', async (req, res) => {
  await pool.query('UPDATE transactions SET status = $1, paid_at = $2 WHERE id = $3', ['paid', Date.now(), req.params.txId]);
  res.sendStatus(200);
});

// CHAT
app.get('/api/chat/:txId', async (req, res) => {
  const r = await pool.query('SELECT * FROM messages WHERE ref_id = $1 ORDER BY created_at ASC', [req.params.txId]);
  res.json(r.rows);
});

app.post('/api/chat/:txId', async (req, res) => {
  const { senderId, content } = req.body;
  await pool.query('INSERT INTO messages (id, ref_id, ref_type, sender_id, content, created_at) VALUES ($1,$2,$3,$4,$5,$6)',
    [genId(), req.params
