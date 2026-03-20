const express = require('express');
const { scrapeBC } = require('./scrapers/bc');

const app = express();
app.use(express.json());

// Simple API key check — set SCRAPER_API_KEY in Railway environment variables
const API_KEY = process.env.SCRAPER_API_KEY;

// Portal credentials — stored securely in Railway environment variables
// n8n never needs to send passwords
const PORTAL_CREDENTIALS = {
  bc: {
    username: process.env.BC_USERNAME,
    password: process.env.BC_PASSWORD
  }
};

function checkApiKey(req, res, next) {
  if (!API_KEY) return next();
  const provided = req.headers['x-api-key'];
  if (provided !== API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

// Health check — use this in Railway to verify the service is running
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Main scrape endpoint — n8n calls this via HTTP Request node
// POST /scrape
// Body: { "portal": "bc", "url": "https://..." }
// Credentials are read from Railway environment variables, not from the request
app.post('/scrape', checkApiKey, async (req, res) => {
  const { portal, url } = req.body;

  if (!portal || !url) {
    return res.status(400).json({
      error: 'Missing required fields',
      required: ['portal', 'url']
    });
  }

  const credentials = PORTAL_CREDENTIALS[portal];
  if (!credentials?.username || !credentials?.password) {
    return res.status(500).json({ error: `Credentials not configured for portal: ${portal}` });
  }

  console.log(`[${new Date().toISOString()}] Scraping portal=${portal} url=${url}`);

  try {
    let data;

    if (portal === 'bc') {
      data = await scrapeBC(url, credentials);
    } else {
      return res.status(400).json({ error: `Unsupported portal: ${portal}. Supported: bc` });
    }

    console.log(`[${new Date().toISOString()}] Success:`, JSON.stringify(data));
    res.json(data);

  } catch (err) {
    console.error(`[${new Date().toISOString()}] Error:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`GCP Scraper Service running on port ${PORT}`);
});
