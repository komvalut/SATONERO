// server.js
require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json());
app.use(express.static('public')); // Frontend fajlovi će biti ovde

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Pomoćna funkcija za generisanje ID-eva
const genId = () => crypto.randomBytes(8).toString('hex');

// --- DATABASE INIT ---
async function initDb() {
  const client = await pool.connect();
  try {
    // 1. Kreiranje svih tabela iz tvog uputstva
    await client.query(`
      CREATE TABLE IF NOT EXISTS assets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        symbol TEXT,
        contract_address TEXT,
        decimals INT DEFAULT 18,
        network TEXT,
        active BOOLEAN DEFAULT true,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        email TEXT,
        balance_sats INT DEFAULT 0,
        rating NUMERIC DEFAULT 5.0,
        total_trades INT DEFAULT 0,
        trusted BOOLEAN DEFAULT false,
        created_at BIGINT
      );

      CREATE TABLE IF NOT EXISTS listings (
        id TEXT PRIMARY KEY,
        seller_id TEXT NOT NULL,
        offer_asset TEXT NOT NULL,
        offer_amount NUMERIC NOT NULL,
        want_asset TEXT NOT NULL,
        want_amount NUMERIC NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active',
        created_at BIGINT
      );

      -- Dodaj i ostale tabele ovde (transactions, loans, tasks, predictions, data_listings, messages, ratings)
      -- Skratio sam kod radi preglednosti, ali ubaci sve iz tvog SQL koda.
    `);

    // 2. Ubacivanje početnih aseta
    const assetsJson = [
      ['sats', 'Satoshi (Lightning)', 'crypto', 'SATS'],
      ['btc', 'Bitcoin', 'crypto', 'BTC'],
      ['ltc', 'Litecoin', 'crypto', 'LTC'],
      ['usdt', 'Tether USDT', 'crypto', 'USDT'],
      ['paysafe', 'Paysafecard', 'voucher', null],
      ['steam', 'Steam Gift Card', 'giftcard', null]
    ];

    for (let asset of assetsJson) {
      await client.query(
        `INSERT INTO assets (id, name, type, symbol, active, created_at) 
         VALUES ($1, $2, $3, $4, true, $5) ON CONFLICT (id) DO NOTHING`,
        [...asset, Date.now()]
      );
    }
    console.log("✅ Baza podataka i aseti inicijalizovani.");
  } finally {
    client.release();
  }
}

initDb();

// --- API RUTE (ASSETS) ---

// Get svi aktivni aseti
app.get('/api/assets', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM assets WHERE active = true ORDER BY type, name');
    res.json(result.rows);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Admin dodavanje aseta
app.post('/api/admin/assets', async (req, res) => {
  const { adminKey, id, name, type, symbol, contractAddress, decimals, network } = req.body;
  if (adminKey !== process.env.ADMIN_KEY) return res.status(401).send('Unauthorized');

  try {
    await pool.query(
      `INSERT INTO assets (id, name, type, symbol, contract_address, decimals, network, created_at) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [id, name, type, symbol, contractAddress, decimals || 18, network, Date.now()]
    );
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 Server na portu ${PORT}`));
