/**
 * BuildingConnected (Autodesk) scraper
 *
 * Logs into BC using Autodesk Identity, navigates to a bid invite page,
 * and extracts project data to populate a Trello card.
 *
 * NOTE: BC is a React app so class names are unstable. We use text-based
 * and structural selectors. If fields come back empty after a BC update,
 * the selectors below are the first place to look.
 */

const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const SESSION_PATH = path.join(__dirname, '../sessions/bc-session.json');

async function scrapeBC(url, credentials) {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });

  let context;
  if (fs.existsSync(SESSION_PATH)) {
    console.log('[BC] Loading cached session');
    context = await browser.newContext({ storageState: SESSION_PATH });
  } else {
    console.log('[BC] No cached session');
    context = await browser.newContext();
  }

  const page = await context.newPage();

  try {
    // Step 1: Navigate to the BC opportunity URL
    console.log(`[BC] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Step 2: Login if redirected to Autodesk Identity
    const currentUrl = page.url();
    if (currentUrl.includes('autodesk.com') || currentUrl.includes('/login') || currentUrl.includes('accounts.')) {
      console.log(`[BC] Login page detected at: ${currentUrl}`);
      await login(page, credentials);

      // Save session so we don't have to login next time
      fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
      await context.storageState({ path: SESSION_PATH });
      console.log('[BC] Session saved');

      // Navigate to the original URL now that we're logged in
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    }

    // Step 3: Wait for the React app to fully render
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {
      console.log('[BC] Network idle timeout — continuing anyway');
    });
    await page.waitForTimeout(3000); // Extra buffer for React rendering

    // Step 4: Extract data
    const data = await extractBCData(page, url);
    return data;

  } finally {
    await browser.close();
  }
}

async function login(page, credentials) {
  console.log('[BC] Starting Autodesk login...');

  // Autodesk Identity shows email field first
  await page.waitForSelector('input[name="userName"], input[type="email"]', { timeout: 20000 });
  await page.fill('input[name="userName"], input[type="email"]', credentials.username);

  // Click Next
  await page.locator('button[type="submit"], input[type="submit"]').first().click();
  console.log('[BC] Submitted email, waiting for password field...');

  // Then shows password field
  await page.waitForSelector('input[type="password"]', { timeout: 15000 });
  await page.fill('input[type="password"]', credentials.password);

  // Sign in
  await page.locator('button[type="submit"], input[type="submit"]').last().click();
  console.log('[BC] Submitted password, waiting for redirect to BC...');

  // Wait until we're back on buildingconnected.com
  await page.waitForURL('**buildingconnected.com**', { timeout: 30000 });
  console.log('[BC] Login successful');
}

async function extractBCData(page, originalUrl) {
  // Run extraction logic in the browser context for full DOM access
  const raw = await page.evaluate(() => {
    /**
     * Finds a labeled field by its label text and returns the associated value.
     * BC uses various patterns: label + sibling, label + adjacent div, key-value rows.
     */
    function getFieldValue(labelText) {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      let node;
      while ((node = walker.nextNode())) {
        if (node.textContent.trim() === labelText) {
          const el = node.parentElement;
          if (!el) continue;

          // Pattern 1: value is next sibling element
          const nextSib = el.nextElementSibling;
          if (nextSib && nextSib.textContent.trim()) {
            return nextSib.textContent.trim();
          }

          // Pattern 2: value is in parent's next sibling
          const parentNextSib = el.parentElement?.nextElementSibling;
          if (parentNextSib && parentNextSib.textContent.trim()) {
            const text = parentNextSib.textContent.trim();
            if (text !== labelText) return text;
          }

          // Pattern 3: value is second child of grandparent
          const grandparent = el.parentElement?.parentElement;
          if (grandparent) {
            const children = [...grandparent.children];
            const idx = children.findIndex(c => c.contains(el));
            if (idx >= 0 && children[idx + 1]) {
              const text = children[idx + 1].textContent.trim();
              if (text) return text;
            }
          }
        }
      }
      return '';
    }

    /**
     * Gets text content of the first element matching a CSS selector.
     */
    function getText(selector) {
      return document.querySelector(selector)?.textContent?.trim() || '';
    }

    /**
     * Gets all text content from a section identified by a heading keyword.
     */
    function getSectionText(headingKeyword) {
      const headings = [...document.querySelectorAll('h2, h3, h4, [class*="heading"], [class*="title"]')];
      const heading = headings.find(h => h.textContent.includes(headingKeyword));
      if (!heading) return '';
      const section = heading.closest('section, [class*="section"], [class*="card"], [class*="panel"]');
      return section ? section.textContent : '';
    }

    // --- Project name (main h1) ---
    const jobName = getText('h1');

    // --- Trade (subtitle below h1 — often in a p or span right after the h1) ---
    const h1El = document.querySelector('h1');
    let trade = '';
    if (h1El) {
      const sibling = h1El.nextElementSibling;
      if (sibling && sibling.textContent.trim().length < 50) {
        trade = sibling.textContent.trim();
      }
    }

    // --- Due date (top-right, labeled "Due date" or "Bid Date") ---
    const dueDateRaw = getFieldValue('Due date') || getFieldValue('Bid Date') || getFieldValue('Due Date');

    // --- Date Due from Project Dates section (the sub-contractor bid deadline) ---
    const dateDueRaw = getFieldValue('Date Due');

    // --- Site Walk ---
    const siteWalkRaw = getFieldValue('Site Walk') || getFieldValue('Site visit');

    // --- RFIs Due ---
    const rfisDueRaw = getFieldValue('RFIs Due') || getFieldValue('RFI Due') || getFieldValue('RFIs due');

    // --- Client / GC name ---
    // BC shows the GC (inviting company) under a "Client" heading
    const clientSectionText = getSectionText('Client');
    // The company name is typically the first substantial text line in the Client section
    let client1 = '';
    let contact1 = '';
    if (clientSectionText) {
      const lines = clientSectionText
        .split('\n')
        .map(l => l.trim())
        .filter(l => l.length > 2 && l !== 'Client');
      client1 = lines[0] || '';
      contact1 = lines[1] || '';
    }

    // --- Location ---
    const location = getFieldValue('Location');

    // --- Debug: full body text for troubleshooting ---
    const bodyText = document.body.innerText.substring(0, 3000);

    return {
      jobName,
      trade,
      dueDateRaw,
      dateDueRaw,
      siteWalkRaw,
      rfisDueRaw,
      client1,
      contact1,
      location,
      bodyText // included so we can debug selector issues from Railway logs
    };
  });

  console.log('[BC] Raw extracted data:', JSON.stringify({
    jobName: raw.jobName,
    trade: raw.trade,
    dueDateRaw: raw.dueDateRaw,
    dateDueRaw: raw.dateDueRaw,
    siteWalkRaw: raw.siteWalkRaw,
    rfisDueRaw: raw.rfisDueRaw,
    client1: raw.client1,
    contact1: raw.contact1,
    location: raw.location
  }));

  // Format the card title to match Stage 1 pattern: "Project Name: Trade"
  const cardTitle = raw.trade
    ? `${raw.jobName}: ${raw.trade}`
    : raw.jobName;

  // Parse dates to ISO 8601 UTC (end of day EDT = 20:00:00Z per timezone fix in Stage 1)
  const dueDateISO = parseDateToISO(raw.dueDateRaw);
  const siteVisitISO = parseDateToISO(raw.siteWalkRaw);
  const rfiDueDateISO = parseDateToISO(raw.rfisDueRaw);

  // Build description
  const description = [
    `Project: ${raw.jobName}${raw.trade ? ' – ' + raw.trade + ' scope' : ''}`,
    raw.location ? `Location: ${raw.location}` : '',
    raw.dateDueRaw ? `Date Due: ${raw.dateDueRaw}` : '',
    raw.siteWalkRaw ? `Site Walk: ${raw.siteWalkRaw}` : '',
    raw.rfisDueRaw ? `RFIs Due: ${raw.rfisDueRaw}` : '',
    '',
    'Auto-imported from BuildingConnected.'
  ].filter(Boolean).join('\n');

  return {
    // Fields used by the existing Stage 1 n8n workflow
    projectName: cardTitle,
    gcName: raw.client1,
    contactName: raw.contact1,
    address: raw.location,
    description,
    dueDate: dueDateISO,
    bcUrl: originalUrl,
    attachmentLabel: `BC ${raw.client1}`,

    // Additional fields for future Trello custom fields
    siteVisitDate: siteVisitISO,
    rfiDueDate: rfiDueDateISO
  };
}

/**
 * Parses a date string like "Mar 24, 2026" or "Mar 16, 2026 at 9:00 AM PST"
 * into an ISO 8601 UTC timestamp.
 *
 * Per Stage 1 timezone fix: use 20:00:00.000Z (end of business day EDT)
 * so the date doesn't roll back to the previous day in UTC.
 */
function parseDateToISO(dateStr) {
  if (!dateStr) return '';
  try {
    const match = dateStr.match(/([A-Za-z]+ \d{1,2},\s*\d{4})/);
    if (!match) return '';
    const date = new Date(match[1]);
    if (isNaN(date.getTime())) return '';
    date.setUTCHours(20, 0, 0, 0); // End of business day EDT
    return date.toISOString();
  } catch {
    return '';
  }
}

module.exports = { scrapeBC };
