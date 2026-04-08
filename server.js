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
    // Try every possible field name variation
    const stock = row['Stock'] || row['StockNumber'] || row['stock_number'] || row['stock'] || row['STOCK'] || `${i+1}`;
    const vin = row['VIN'] || row['Vin'] || row['vin'] || '';
    const year = row['Year'] || row['year'] || row['YEAR'] || '';
    const make = row['Make'] || row['make'] || row['MAKE'] || '';
    const model = row['Model'] || row['model'] || row['MODEL'] || '';

    // Price — try many variations
    const rawPrice = row['Price'] || row['price'] || row['SalePrice'] || row['sale_price'] ||
      row['ListPrice'] || row['list_price'] || row['RetailPrice'] || row['retail_price'] ||
      row['OurPrice'] || row['our_price'] || row['InternetPrice'] || row['internet_price'] ||
      row['SellingPrice'] || row['selling_price'] || row['PRICE'] || '0';

    // Miles — try many variations
    const rawMiles = row['Mileage'] || row['mileage'] || row['Miles'] || row['miles'] ||
      row['Odometer'] || row['odometer'] || row['MILEAGE'] || row['MILES'] || '0';

    // Photo
    const image = row['ImageURL'] || row['image_url'] || row['Photo'] || row['photo'] ||
      row['MainPhoto'] || row['main_photo'] || row['PhotoURL'] || row['photo_url'] ||
      row['Image'] || row['image'] || row['Picture'] || row['picture'] || '';

    const priceNum = parseInt(String(rawPrice).replace(/[^0-9]/g, '')) || 0;
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
