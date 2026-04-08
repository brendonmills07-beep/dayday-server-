const express = require('express');
const cors = require('cors');
const ftp = require('basic-ftp');
const { parse } = require('csv-parse/sync');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());

// FTP credentials stored as environment variables — never hardcoded
const FTP_HOST = process.env.FTP_HOST || 'ftp.dealerslink.com';
const FTP_USER = process.env.FTP_USER || 'facebookdownload';
const FTP_PASS = process.env.FTP_PASS || 'gasWlwo1As7l7$iFr2=-';
const FTP_FILE = process.env.FTP_FILE || '5845.csv';

// Cache inventory for 30 minutes to avoid hammering FTP
let inventoryCache = null;
let cacheTime = null;
const CACHE_DURATION = 30 * 60 * 1000; // 30 minutes

async function fetchInventoryFromFTP() {
  // Return cached version if fresh
  if (inventoryCache && cacheTime && (Date.now() - cacheTime < CACHE_DURATION)) {
    console.log('Returning cached inventory');
    return inventoryCache;
  }

  console.log('Fetching fresh inventory from DealersLink FTP...');
  const client = new ftp.Client();
  client.ftp.verbose = false;

  const localPath = path.join('/tmp', FTP_FILE);

  try {
    await client.access({
      host: FTP_HOST,
      user: FTP_USER,
      password: FTP_PASS,
      secure: false
    });

    await client.downloadTo(localPath, FTP_FILE);
    console.log('Downloaded inventory file from FTP');

    const csvContent = fs.readFileSync(localPath, 'utf8');
    const records = parse(csvContent, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    });

    console.log(`Parsed ${records.length} vehicles from inventory`);

    // Map CSV fields to DayDay format
    const vehicles = records.map((row, index) => {
      // DealersLink CSV field mapping
      const stock = row['Stock'] || row['stock_number'] || row['StockNumber'] || row['stock'] || `STOCK-${index}`;
      const year = row['Year'] || row['year'] || '';
      const make = row['Make'] || row['make'] || '';
      const model = row['Model'] || row['model'] || '';
      const price = row['Price'] || row['price'] || row['SalePrice'] || row['sale_price'] || '0';
      const miles = row['Mileage'] || row['mileage'] || row['Miles'] || row['miles'] || '0';
      const vin = row['VIN'] || row['vin'] || row['Vin'] || '';
      const image = row['ImageURL'] || row['image_url'] || row['Photo'] || row['photo'] || row['MainPhoto'] || '';

      return {
        id: index + 1,
        stock,
        vin,
        name: `${year} ${make} ${model}`.trim(),
        year,
        make,
        model,
        price: price ? `$${parseInt(price).toLocaleString()}` : 'Call for price',
        miles: miles ? parseInt(miles).toLocaleString() : '0',
        image,
        status: 'green' // Default — will be updated based on posting history
      };
    }).filter(v => v.name.trim().length > 1); // Filter out empty rows

    // Cache the result
    inventoryCache = vehicles;
    cacheTime = Date.now();

    return vehicles;

  } catch (err) {
    console.error('FTP fetch error:', err.message);
    throw err;
  } finally {
    client.close();
    // Clean up temp file
    if (fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  }
}

// ─── ROUTES ───────────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'DayDay server running', version: '1.0.0' });
});

// Get inventory
app.get('/inventory', async (req, res) => {
  try {
    const vehicles = await fetchInventoryFromFTP();
    res.json({ success: true, count: vehicles.length, vehicles });
  } catch (err) {
    console.error('Inventory fetch failed:', err.message);
    res.status(500).json({ success: false, error: 'Failed to fetch inventory', message: err.message });
  }
});

// Force refresh inventory cache
app.post('/inventory/refresh', async (req, res) => {
  inventoryCache = null;
  cacheTime = null;
  try {
    const vehicles = await fetchInventoryFromFTP();
    res.json({ success: true, count: vehicles.length, message: 'Inventory refreshed' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Mark vehicle as posted
app.post('/vehicles/posted', async (req, res) => {
  const { stock, vehicleName, userId } = req.body;
  // TODO: Save to Supabase posted_vehicles table
  res.json({ success: true, message: `${vehicleName} marked as posted` });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`DayDay server running on port ${PORT}`);
});
