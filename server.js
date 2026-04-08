const express = require('express');
const cors = require('cors');
const ftp = require('basic-ftp');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
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
app.get('/inventory', async (req, res) => {
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`DayDay server running on port ${PORT}`));
