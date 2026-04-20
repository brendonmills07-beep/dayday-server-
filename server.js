const express = require('express');
const cors = require('cors');
const ftp = require('basic-ftp');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

// Simple in-memory rate limiter
const rateLimitMap = new Map();
function rateLimit(maxRequests, windowMs) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || 'unknown';
    const key = ip + req.path;
    const now = Date.now();
    if (!rateLimitMap.has(key)) {
      rateLimitMap.set(key, { count: 1, start: now });
      return next();
    }
    const entry = rateLimitMap.get(key);
    if (now - entry.start > windowMs) {
      rateLimitMap.set(key, { count: 1, start: now });
      return next();
    }
    if (entry.count >= maxRequests) {
      return res.status(429).json({ error: 'Too many requests', retryAfter: Math.ceil((windowMs - (now - entry.start)) / 1000) + 's' });
    }
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
app.use(cors({
  origin: [
    'https://dayday-flax.vercel.app',
    'chrome-extension://likohcdekpbgfbcphbdmojoffejidcac',
    'http://localhost:3000',
    '*' // Allow all for now during development
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key']
}));
app.use(express.json());

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
    const csvContent = fs.readFileSync(localPath, 'utf8');
    return csvContent;
  } finally {
    client.close();
    if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
  }
}

async function fetchInventory() {
  if (inventoryCache && cacheTime && (Date.now() - cacheTime < CACHE_DURATION)) return inventoryCache;

  const csv = await fetchCSV();
  const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });

  // Store headers for debugging
  rawHeaders = records.length > 0 ? Object.keys(records[0]) : [];
  console.log('CSV Headers:', rawHeaders);
  console.log('Sample row:', records[0]);

  const vehicles = records.map((row, i) => {
    // Confirmed DealersLink field names
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
    const drivetrain = row['drivetrain'] || '';
    const exteriorColor = row['exterior_color'] || '';
    const condition = row['condition'] || '';

    // Price — use sale_price, fall back to price
    const rawPrice = row['sale_price'] || row['price'] || '0';

    // Miles — field is mileage.value
    const rawMiles = row['mileage.value'] || '0';

    // Photos — DealersLink uses image[0].url through image[23].url
    // Also try image_link as fallback
    const images = [];
    const rowKeys = Object.keys(row);
    // Find all image URL keys
    rowKeys.forEach(key => {
      if (key.match(/^image\[\d+\]\.url$/) || key === 'image_link') {
        const val = row[key];
        if (val && val.trim() && val.startsWith('http')) {
          images.push(val.trim());
        }
      }
    });
    const image = images[0] || row['image_link'] || '';

    const priceNum = parseInt(String(rawPrice).replace(' USD','').replace(/[^0-9]/g, '')) || 0;
    const milesNum = parseInt(String(rawMiles).replace(/[^0-9]/g, '')) || 0;

    return {
      id: i + 1,
      stock,
      vin,
      name: `${year} ${make} ${model}`.trim(),
      year,
      make,
      model,
      price: priceNum > 0 ? `$${priceNum.toLocaleString()}` : 'Call for price',
      miles: milesNum > 0 ? milesNum.toLocaleString() : '0',
      image,
      images,
      title,
      description,
      bodyStyle,
      fuelType,
      transmission,
      drivetrain,
      exteriorColor,
      condition,
      status: 'green'
    };
  }).filter(v => v.name.trim().length > 1);

  inventoryCache = vehicles;
  cacheTime = Date.now();
  return vehicles;
}

// Health check
app.get('/', (req, res) => res.json({ status: 'DayDay server running', version: '1.1.0' }));

// Get inventory
// Sanitize string inputs
function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.replace(/[<>"'%;()&+]/g, '').trim().slice(0, 500);
}

app.get('/inventory', rateLimit(30, 5 * 60 * 1000), async (req, res) => {
  try {
    const vehicles = await fetchInventory();
    res.json({ success: true, count: vehicles.length, vehicles });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Debug — see raw first row with all values
app.get('/debug/firstrow', async (req, res) => {
  try {
    const csv = await fetchCSV();
    const records = parse(csv, { columns: true, skip_empty_lines: true, trim: true });
    const first = records[0];
    // Show only keys that have values
    const populated = {};
    Object.keys(first).forEach(k => {
      if (first[k] && first[k].trim()) populated[k] = first[k];
    });
    res.json({ all_keys: Object.keys(first), populated_keys: populated });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Debug — see raw CSV headers and first row
app.get('/debug/headers', async (req, res) => {
  try {
    inventoryCache = null;
    cacheTime = null;
    await fetchInventory();
    res.json({ headers: rawHeaders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Force refresh
app.post('/inventory/refresh', async (req, res) => {
  inventoryCache = null;
  cacheTime = null;
  try {
    const vehicles = await fetchInventory();
    res.json({ success: true, count: vehicles.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// Photo proxy — fetches DealersLink S3 images and serves them
// This bypasses CORS since our server fetches the image, not Facebook
app.get('/photo', rateLimit(200, 60 * 1000), async (req, res) => {
  const url = req.query.url;
  if (!url || typeof url !== 'string') return res.status(400).json({ error: 'No URL provided' });
  
  // Strict URL validation — only allow DealersLink S3 URLs
  let parsedUrl;
  try { parsedUrl = new URL(url); } catch(e) { return res.status(400).json({ error: 'Invalid URL' }); }
  
  const allowedHosts = ['dealerslink.s3.amazonaws.com', 's3.amazonaws.com'];
  if (!allowedHosts.some(h => parsedUrl.hostname.endsWith(h))) {
    return res.status(403).json({ error: 'URL not allowed' });
  }

  try {
    const response = await fetch(url);
    if (!response.ok) return res.status(404).json({ error: 'Image not found' });

    const buffer = await response.arrayBuffer();
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    res.set({
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=3600'
    });
    res.send(Buffer.from(buffer));
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DayDay server running on port ${PORT}`));
