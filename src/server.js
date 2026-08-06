/**
 * Leader → Halo Product Sync — Express server.
 *
 * Served under a configurable path prefix (BASE_PATH), e.g. '/Leader-Halo/'
 * behind HAProxy, or '/' for local dev. The frontend reads a <base> tag injected
 * into index.html so its relative fetches resolve correctly under any prefix.
 *
 * Endpoints (all under BASE_PATH):
 *   GET  /                — the UI (static)
 *   GET  /api/status      — catalogue row count + last refresh
 *   POST /api/lookup      — { sku } → matched product + pricing (no Halo write)
 *   POST /api/price       — { dbp, category } → re-priced (no DB hit)
 *   POST /api/confirm     — { product, category } → creates the item in Halo
 *   POST /api/refresh     — manually trigger a catalogue refresh
 *   GET/POST /api/margins       — read/replace the margin table
 *   POST   /api/category        — add a pricing category { name, margin? }
 *   DELETE /api/category?name=  — remove a pricing category
 *   GET/POST /api/category-map  — read/replace Leader→pricing category map
 */
import 'dotenv/config';
import fs from 'fs';
import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

import { lookupProduct, lookupByAnyCode, searchCatalogue, replaceCatalogue, getStatus, getMeta, setMeta } from './db.js';
import {
  priceProduct, mapCategory, getCategories,
  getMargins, setMargins, addCategory, removeCategory,
  getCategoryMap, setCategoryMap,
} from './pricing.js';
import { fetchCatalogue } from './leader.js';
import { createItem, buildHaloPayload, findExistingItem, uploadSelectedImages, setPrimaryImage, getAssetGroups, linkItemToQbo, getAllItems, getQboItems, qboEnabled } from './halo.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'public');

// Base path the app is served under. Must start and end with '/'. Default '/'.
const BASE_PATH = (() => {
  let b = (process.env.BASE_PATH || '/').trim();
  if (!b.startsWith('/')) b = '/' + b;
  if (!b.endsWith('/')) b = b + '/';
  return b;
})();
// For local dev at '/', we keep the simple form without a trailing segment.
const mountAt = BASE_PATH === '/' ? '/' : BASE_PATH;

const app = express();
const router = express.Router();
router.use(express.json({ limit: '2mb' }));

const PORT = process.env.PORT || 9100;

// ─── API routes (on the router) ────────────────────────────────────────────

router.get('/api/status', (_req, res) => {
  res.json(getStatus());
});

/** Check edit password — returns {ok: true} or {ok: false}. */
router.post('/api/auth', (req, res) => {
  const pw = process.env.EDIT_PASSWORD || '';
  res.json({ ok: pw && req.body?.password === pw });
});

/** Search the catalogue by substring (for the autocomplete dropdown). */
router.get('/api/search', (req, res) => {
  const q = req.query.q || '';
  res.json(searchCatalogue(q));
});

/** Return Halo asset groups for the item-group selector. */
router.get('/api/groups', async (_req, res) => {
  try {
    res.json(await getAssetGroups());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/** Return QBO items for the QBO link selector (only if QBO sync enabled). */
router.get('/api/qbo-items', async (_req, res) => {
  try {
    res.json({ enabled: qboEnabled(), items: await getQboItems() });
  } catch (err) {
    res.status(500).json({ enabled: false, items: [], error: err.message });
  }
});

/**
 * Price audit: fetch all Halo items, match each against the Leader catalogue,
 * compare current vs proposed prices. Returns matched items with deviations.
 */
router.get('/api/audit', async (_req, res) => {
  try {
    const haloItems = await getAllItems();
    const results = [];
    for (const h of haloItems) {
      // Try to match this Halo item to a Leader product by any of its codes.
      const codes = [h.supplier_part_code, h.default_supplier_part_code, h.qbosku]
        .filter((c) => c && c !== '0' && c !== 'NO_UPDATE' && c !== 'true' && c !== 'false');
      const leader = lookupByAnyCode(codes);
      if (!leader) continue;

      const category = mapCategory(leader.category, leader.manufacturer, leader.name);
      const pricing = priceProduct(leader.dbp, category);
      const haloBase = h.baseprice || 0;
      const haloCost = h.costprice || 0;
      const proposedRetail = pricing.retailExGst;
      const proposedCost = pricing.costExGst;

      results.push({
        halo: {
          id: h.id,
          name: h.name,
          currentRetail: haloBase,
          currentCost: haloCost,
          url: `${process.env.HALO_BASE_URL || 'https://halo.elliotts.tech'}/items?itemid=${h.id}`,
        },
        leader: {
          stockCode: leader.stockCode,
          manufacturerSku: leader.manufacturerSku,
          name: leader.name,
          dbp: leader.dbp,
        },
        proposed: {
          retailEx: proposedRetail,
          costEx: proposedCost,
          category,
          marginPct: pricing.marginPct,
        },
        deviation: {
          priceDiff: Math.round((proposedRetail - haloBase) * 100) / 100,
          pricePct: haloBase ? Math.round(((proposedRetail - haloBase) / haloBase) * 1000) / 10 : null,
          costDiff: Math.round((proposedCost - haloCost) * 100) / 100,
          costPct: haloCost ? Math.round(((proposedCost - haloCost) / haloCost) * 1000) / 10 : null,
        },
      });
    }
    res.json({ total: haloItems.length, matched: results.length, items: results });
  } catch (err) {
    console.error('Audit failed:', err.message);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api/lookup', async (req, res) => {
  const sku = req.body?.sku;
  const product = lookupProduct(sku);
  if (!product) {
    return res.json({ status: 'not_found', sku, message: `No match for "${sku}".` });
  }
  const category = mapCategory(product.category, product.manufacturer, product.name);
  const pricing = priceProduct(product.dbp, category);

  // De-dupe: check if this SKU already exists in Halo.
  let existing = null;
  try {
    existing = await findExistingItem(product.stockCode, product.manufacturerSku);
  } catch (e) {
    console.warn('De-dupe check failed (non-blocking):', e.message);
  }

  res.json({
    status: 'matched', sku, product, pricing,
    categories: getCategories(),
    qboEnabled: qboEnabled(),
    existing: existing ? {
      id: existing.id,
      name: existing.name,
      description: existing.description || '',
      baseprice: existing.baseprice,
      costprice: existing.costprice,
      linkedItemId: existing.linked_item_id || 0,
      url: `${process.env.HALO_BASE_URL || 'https://halo.elliotts.tech'}/items?itemid=${existing.id}`,
    } : null,
  });
});

router.post('/api/price', (req, res) => {
  const { dbp, category } = req.body;
  if (typeof dbp !== 'number') return res.status(400).json({ error: 'dbp required' });
  const pricing = priceProduct(dbp, category || 'Computers');
  res.json({ pricing, categories: getCategories() });
});

router.post('/api/confirm', async (req, res) => {
  try {
    const { product, category, existingId, assetGroupId, nameOverride, descOverride, images, qboItemId } = req.body;
    if (!product) return res.status(400).json({ error: 'product required' });
    const breakdown = priceProduct(product.dbp, category || 'Computers');
    const payload = buildHaloPayload(product, breakdown, existingId, assetGroupId, {
      nameOverride: nameOverride || null,
      descOverride: descOverride != null ? descOverride : undefined,
      qboItemId: qboItemId || null,
    });
    const result = await createItem(payload);
    const itemId = result.id;
    const verb = existingId ? 'updated' : 'created';

    // QBO link for new items (the payload already includes linked_item_id for
    // updates when QBO is enabled; new items need a separate call).
    let qboStatus = qboEnabled() ? 'pending' : 'disabled';
    if (!existingId && qboEnabled()) {
      try {
        qboStatus = (await linkItemToQbo(itemId, qboItemId)) ? 'linked' : 'failed';
      } catch (e) {
        console.warn('QBO link failed:', e.message);
        qboStatus = 'failed: ' + e.message;
      }
    }

    // Image upload: use the selected URLs from the picker, set primary.
    let imageStatus = 'skipped';
    const selectedUrls = images?.selected || [];
    const primaryUrl = images?.primaryUrl || null;
    if (selectedUrls.length > 0) {
      try {
        const { count, primaryId } = await uploadSelectedImages(itemId, selectedUrls, primaryUrl);
        imageStatus = count > 0 ? `uploaded ${count}` : 'no images uploaded';
        if (primaryId) {
          await setPrimaryImage(itemId, primaryId);
        }
      } catch (e) {
        console.warn('Image upload failed:', e.message);
        imageStatus = 'failed: ' + e.message;
      }
    }

    res.json({
      status: verb,
      itemId,
      name: result.name,
      imageStatus,
      qboStatus,
      url: `${process.env.HALO_BASE_URL || 'https://halo.elliotts.tech'}/items?itemid=${itemId}`,
    });
  } catch (err) {
    console.error('Confirm failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/api/refresh', async (_req, res) => {
  try {
    const rows = await fetchCatalogue();
    const { count } = replaceCatalogue(rows);
    res.json({ status: 'refreshed', count });
  } catch (err) {
    console.error('Refresh failed:', err.message);
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.get('/api/margins', (_req, res) => {
  res.json(getMargins());
});

router.post('/api/margins', (req, res) => {
  try {
    setMargins(req.body);
    setMeta('margin_table', JSON.stringify(getMargins()));
    res.json({ status: 'saved' });
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

router.post('/api/category', (req, res) => {
  try {
    const { name, margin } = req.body || {};
    addCategory(name, margin);
    setMeta('margin_table', JSON.stringify(getMargins()));
    res.json({ status: 'added', categories: getCategories() });
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

router.delete('/api/category', (req, res) => {
  try {
    const name = req.query.name || req.body?.name;
    removeCategory(name);
    setMeta('margin_table', JSON.stringify(getMargins()));
    const map = getCategoryMap();
    for (const k of Object.keys(map)) {
      if (!getCategories().includes(map[k])) delete map[k];
    }
    setCategoryMap(map);
    setMeta('category_map', JSON.stringify(map));
    res.json({ status: 'removed', categories: getCategories() });
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

router.get('/api/category-map', (_req, res) => {
  res.json(getCategoryMap());
});

router.post('/api/category-map', (req, res) => {
  try {
    setCategoryMap(req.body);
    setMeta('category_map', JSON.stringify(getCategoryMap()));
    res.json({ status: 'saved' });
  } catch (err) {
    res.status(400).json({ status: 'error', message: err.message });
  }
});

// ─── Static UI (with <base> injection so relative URLs honour the prefix) ───
// Serve index.html with a <base href="BASE_PATH"> injected, so the browser
// resolves app.js, styles.css, and relative /api/... fetches under the prefix.
// Read fresh on each request so HTML edits take effect without a restart.
router.get('/', (_req, res) => {
  let html = fs.readFileSync(path.join(PUBLIC_DIR, 'index.html'), 'utf8');
  if (!html.includes('<base')) {
    html = html.replace('<head>', `<head>\n    <base href="${BASE_PATH}">`);
  }
  res.type('html').send(html);
});

router.use(express.static(PUBLIC_DIR));

// ─── Mount the router ──────────────────────────────────────────────────────
app.use(mountAt, router);

// Price calculator page — served at ROOT (not under BASE_PATH).
// Uses its own API router so it's independent of the /Leader-Halo/ prefix.
const calcRouter = express.Router();
calcRouter.use(express.json({ limit: '2mb' }));
// Re-mount the same API routes under root for the calculator.
calcRouter.get('/api/status', (_req, res) => res.json(getStatus()));
calcRouter.post('/api/auth', (req, res) => {
  const pw = process.env.EDIT_PASSWORD || '';
  res.json({ ok: pw && req.body?.password === pw });
});
calcRouter.get('/api/margins', (_req, res) => res.json(getMargins()));
calcRouter.post('/api/margins', (req, res) => {
  try { setMargins(req.body); setMeta('margin_table', JSON.stringify(getMargins())); res.json({ status: 'saved' }); }
  catch (err) { res.status(400).json({ status: 'error', message: err.message }); }
});
calcRouter.post('/api/category', (req, res) => {
  try { const { name, margin } = req.body || {}; addCategory(name, margin); setMeta('margin_table', JSON.stringify(getMargins())); res.json({ status: 'added', categories: getCategories() }); }
  catch (err) { res.status(400).json({ status: 'error', message: err.message }); }
});
calcRouter.delete('/api/category', (req, res) => {
  try { removeCategory(req.query.name); setMeta('margin_table', JSON.stringify(getMargins())); res.json({ status: 'removed', categories: getCategories() }); }
  catch (err) { res.status(400).json({ status: 'error', message: err.message }); }
});
calcRouter.get('/price-calc', (_req, res) => {
  res.type('html').sendFile(path.join(PUBLIC_DIR, 'calc.html'));
});
calcRouter.use(express.static(PUBLIC_DIR));
app.use('/', calcRouter);

// When mounted under a sub-path, redirect the bare prefix (no trailing slash)
// to the slashed form so <base> relative resolution works.
if (mountAt !== '/') {
  const bare = mountAt.replace(/\/$/, '');
  app.get(bare, (req, res) => res.redirect(mountAt));
}

// Root health check (useful when proxied at '/').
app.get('/', (req, res, next) => {
  if (mountAt === '/') return next();
  res.type('text').send('Leader → Halo sync is running. See ' + mountAt);
});

// ─── Background refresh ────────────────────────────────────────────────────
let refreshing = false;
async function refreshInBackground() {
  if (refreshing) return;
  refreshing = true;
  try {
    console.log('[refresh] downloading Leader catalogue…');
    const rows = await fetchCatalogue();
    const { count } = replaceCatalogue(rows);
    console.log(`[refresh] done — ${count} rows.`);
  } catch (err) {
    console.error('[refresh] failed:', err.message);
  } finally {
    refreshing = false;
  }
}
const hours = parseFloat(process.env.LEADER_REFRESH_HOURS || '6');
setInterval(refreshInBackground, hours * 3600 * 1000);

// ─── Start ─────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  console.log(`Leader → Halo sync running on http://localhost:${PORT}${mountAt}`);
  console.log(`Base path: ${BASE_PATH}`);

  const savedMargins = getMeta('margin_table');
  if (savedMargins) {
    try {
      setMargins(JSON.parse(savedMargins));
      console.log('Loaded saved margin table from database.');
    } catch (err) {
      console.warn('Saved margin table invalid, using defaults:', err.message);
    }
  }

  const savedMap = getMeta('category_map');
  if (savedMap) {
    try {
      setCategoryMap(JSON.parse(savedMap));
      console.log('Loaded saved category map from database.');
    } catch (err) {
      console.warn('Saved category map invalid, using defaults:', err.message);
    }
  }

  const { rowCount, lastRefresh } = getStatus();
  console.log(`Catalogue: ${rowCount} rows, last refresh: ${lastRefresh || 'never'}`);
  if (rowCount === 0) {
    console.log('Catalogue empty — starting initial refresh in the background.');
    refreshInBackground();
  }
});
