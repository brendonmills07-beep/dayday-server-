const express = require('express');
const cors = require('cors');
const ftp = require('basic-ftp');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

// Rate limiter
const rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const key = ip + req.path;
    const now = Date.now();
    if (!rateLimitMap.has(key)) { rateLimitMap.set(key, { count: 1, start: now }); return next(); }
    const entry = rateLimitMap.get(key);
    if (now - entry.start > windowMs) { rateLimitMap.set(key, { count: 1, start: now }); return next(); }
    if (entry.count >= maxRequests) return res.status(429).json({ error: 'Too many requests' });
    entry.count++;
    next();
  };
}
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of rateLimitMap.entries()) {
    if (now - val.start > 10 * 60 * 1000) rateLimitMap.delete(key);
  }
}, 10 * 60 * 1000);

const app = express();
app.use(cors({ origin: '*', methods: ['GET', 'POST'], allowedHeaders: ['Content-Type', 'x-api-key'] }));
app.use(express.json());

// API Keys
const VALID_API_KEYS = {
  'dd_live_CITYAUTO_sk_9x2mK8pL': { dealer: 'City Auto Mitsubishi', ftpFile: '5845.csv', active: true }
};

function validateApiKey(req, res, next) {
  if (req.path === '/' || req.path.startsWith('/debug') || req.path === '/photo') return next();
  const apiKey = req.headers['x-api-key'] || req.query.api_key;
  if (!apiKey) return res.status(401).json({ error: 'API key required' });
  const dealer = VALID_API_KEYS[String(apiKey).trim()];
  if (!dealer || !dealer.active) return res.status(403).json({ error: 'Invalid API key' });
  req.dealer = dealer;
  next();
}
app.use(validateApiKey);

// FTP config
const FTP_HOST = process.env.FTP_HOST || 'ftp.dealerslink.com';
const FTP_USER = process.env.FTP_USER || 'facebookdownload';
const FTP_PASS = process.env.FTP_PASS || 'gasWlwo1As7l7$iFr2=-';
const FTP_FILE = process.env.FTP_FILE || '5845.csv';

let inventoryCache = null;
let rawHeaders = null;
let cacheTime = null;
const CACHE_DURATION = 30 * 60 * 1000;

async function fetchCSV() {
  const client = new ftp.Client();
  const localPath = path.join('/tmp', FTP_FILE);
  try {
    await client.access({ host: FTP_HOST, user: FTP_USER, password: FTP_PASS, secure: false });
    await client.downloadTo(localPath, FTP_FILE);
    const csv = fs.readFileSync(localPath, 'utf8');
    return csv;
  } finally {
    client.close();
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  }
}

async function fetchInventory() {
  if (inventoryCache && cacheTime && (Date.now() - cacheTime < CACHE_DURATION)) return inventoryCache;
  const csv = await fetchCSV();
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
  rawHeaders = records.length > 0 ? Object.keys(records[0]) : [];

  const vehicles = records.map((row, i) => {
    const stock = row['stock_number'] || `${i+1}`;
    const vin = row['vin'] || '';
    const year = row['year'] || '';
    const make = row['make'] || '';
    const model = row['model'] || '';
    const title = row['title'] || '';
    const description = row['description'] || '';
    const bodyStyle = row['body_style'] || '';
    const fuelType = row['fuel_type'] || '';
    const transmission = row['transmission'] || '';
    const exteriorColor = row['exterior_color'] || '';
    const condition = row['condition'] || '';
    const rawPrice = row['sale_price'] || row['price'] || '0';
    const rawMiles = row['mileage.value'] || '0';
    const priceNum = parseInt(String(rawPrice).replace(' USD','').replace(/[^0-9]/g,'')) || 0;
    const milesNum = parseInt(String(rawMiles).replace(/[^0-9]/g,'')) || 0;
    const images = [];
    Object.keys(row).forEach(key => {
      if ((key.startsWith('image[') && key.endsWith('].url')) || key === 'image_link') {
        const val = row[key];
        if (val && val.trim() && val.startsWith('http')) images.push(val.trim());
      }
    });
    const image = images[0] || '';
    return {
      id: i+1, stock, vin, name: `${year} ${make} ${model}`.trim(),
      year, make, model, title, description, bodyStyle, fuelType,
      transmission, exteriorColor, condition,
      price: priceNum > 0 ? `$${priceNum.toLocaleString()}` : 'Call for price',
      miles: milesNum > 0 ? milesNum.toLocaleString() : '0',
      image, images, status: 'green'
    };
  }).filter(v => v.name.trim().length > 1);

  inventoryCache = vehicles;
  cacheTime = Date.now();
  return vehicles;
}

// Routes
app.get('/', (req, res) => res.json({ status: 'DayDay server running', version: '1.1.0' }));

app.get('/inventory', rateLimit(30, 5 * 60 * 1000), async (req, res) => {
  try {
    const vehicles = await fetchInventory();
    res.json({ success: true, count: vehicles.length, vehicles });
  } catch(err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/photo', rateLimit(200, 60 * 1000), async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'No URL' });
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch(e) { return res.status(400).json({ error: 'Invalid URL' }); }
  const allowed = ['dealerslink.s3.amazonaws.com', 's3.amazonaws.com'];
  if (!allowed.some(h => parsedUrl.hostname.endsWith(h))) return res.status(403).json({ error: 'URL not allowed' });
  try {
    const response = await fetch(url);
    if (!response.ok) return res.status(404).json({ error: 'Image not found' });
    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';
    res.set({ 'Content-Type': contentType, 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=3600' });
    res.send(Buffer.from(buffer));
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/inventory/refresh', async (req, res) => {
  inventoryCache = null; cacheTime = null;
  try { const v = await fetchInventory(); res.json({ success: true, count: v.length }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug/headers', rateLimit(10, 60 * 1000), async (req, res) => {
  try { inventoryCache = null; cacheTime = null; await fetchInventory(); res.json({ headers: rawHeaders }); }
  catch(e) { res.status(500).json({ error: e.message }); }
});

app.get('/debug/firstrow', rateLimit(10, 60 * 1000), async (req, res) => {
  try {
    const csv = await fetchCSV();
    const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
    const first = records[0];
    const populated = {};
    Object.keys(first).forEach(k => { if (first[k] && first[k].trim()) populated[k] = first[k]; });
    res.json({ all_keys: Object.keys(first), populated_keys: populated });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DayDay server running on port ${PORT}`));
