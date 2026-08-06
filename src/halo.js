/**
 * HaloPSA API client: OAuth2 token + item creation.
 *
 * Field mapping confirmed against the live instance (see project notes):
 *   default_supplier_part_code = Leader stock code (the "NHU-" code)
 *   supplier_part_code         = manufacturer SKU
 *   qbosku                     = barcode
 *   supplier_id 33             = "Leader Systems"
 */

const BASE = process.env.HALO_BASE_URL || 'https://halo.elliotts.tech';

let cachedToken = null;
let tokenExpiry = 0;
const r2 = (n) => Math.round(n * 100) / 100;

/** Fetch (or return cached) a Halo bearer token. */
export async function getToken() {
  if (cachedToken && Date.now() < tokenExpiry - 60_000) return cachedToken;

  const clientId = process.env.HALO_CLIENT_ID;
  const clientSecret = process.env.HALO_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error('HALO_CLIENT_ID / HALO_CLIENT_SECRET not set in .env');
  }

  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: clientId,
    client_secret: clientSecret,
    scope: 'all',
  });

  const res = await fetch(`${BASE}/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    throw new Error(`Halo auth HTTP ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  cachedToken = data.access_token;
  tokenExpiry = Date.now() + (data.expires_in || 3600) * 1000;
  return cachedToken;
}

/**
 * Fetch the item-type asset groups from Halo (for the group selector).
 * @returns {Promise<Array<{id, name}>>}
 */
export async function getAssetGroups() {
  const token = await getToken();
  const res = await fetch(`${BASE}/api/AssetGroup?includetypesforgroups=&type=items&showcounts=false&ticketarea_id=0&istree=true`, {
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`AssetGroup HTTP ${res.status}`);
  const data = await res.json();
  const groups = data.groups || data.assetGroups || data || [];
  return (Array.isArray(groups) ? groups : [groups])
    .filter((g) => g && g.id && g.name)
    .map((g) => ({ id: g.id, name: g.name }));
}

/**
 * Create a product (Item) in Halo.
 * @param {object} payload  the Halo Item payload built by buildHaloPayload
 * @returns {Promise<object>} the created item (id, name, …)
 */
export async function createItem(payload) {
  const token = await getToken();
  const res = await fetch(`${BASE}/api/Item`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    // Halo's POST /api/Item expects a JSON ARRAY of items, not a single object.
    body: JSON.stringify([payload]),
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Halo create HTTP ${res.status}: ${errText.slice(0, 300)}`);
  }
  // Halo POST /api/Item returns the created item (or an array with one item).
  const data = await res.json();
  return Array.isArray(data) ? data[0] : data;
}

/** Whether QBO syncing is enabled (env flag). */
export const qboEnabled = () => process.env.QBO_SYNC_ENABLED === 'true';

/**
 * Fetch QBO items from Halo (the 🅾️ items that exist in QuickBooks).
 * Returns items with id, name, linked_item_id — for the QBO dropdown selector.
 * @returns {Promise<Array<{id, name, linked_item_id}>>}
 */
export async function getQboItems() {
  if (!qboEnabled()) return [];
  const companyId = process.env.QBO_COMPANY_ID || '';
  const token = await getToken();
  const all = [];
  let page = 1;
  while (true) {
    const url = `${BASE}/api/Item?qbitemsonly=true&qbo_company_id=${companyId}&pageinate=true&page_size=100&page_no=${page}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!res.ok) break;
    const data = await res.json();
    const items = data.items || data || [];
    if (!Array.isArray(items) || items.length === 0) break;
    for (const it of items) {
      all.push({ id: it.id, name: it.name || '', linked_item_id: it.linked_item_id || 0 });
    }
    if (items.length < 100) break;
    page++;
  }
  return all;
}

/**
 * Link an item to QuickBooks by setting linked_item_id + taxcodeother=-1.
 * Called after createItem for new items (updates include the link in the payload).
 * @param {number|string} itemId
 * @param {number|string} qboItemId  the QBO item to link to (defaults to self-link)
 */
export async function linkItemToQbo(itemId, qboItemId) {
  if (!qboEnabled()) return false;
  const token = await getToken();
  const linkId = Number(qboItemId || itemId);
  const res = await fetch(`${BASE}/api/Item`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      accept: 'application/json',
    },
    body: JSON.stringify([{
      isitemdetails: true,
      linked_item_id: linkId,
      taxcodeother: '-1',
      id: String(itemId),
    }]),
  });
  if (!res.ok) {
    console.warn(`QBO link failed: HTTP ${res.status}`);
  }
  return res.ok;
}

/**
 * Check whether an item already exists. Searches Halo by both the manufacturer
 * SKU (supplier_part_code) and the Leader stock code (default_supplier_part_code),
 * since existing items may have either field populated.
 * Returns the existing Halo item (with id, name, prices) or null.
 */
export async function findExistingItem(stockCode, mfrSku) {
  const token = await getToken();
  // Search both fields for both codes to catch items regardless of which
  // field was populated when they were originally created.
  const searches = [
    { field: 'supplier_part_code', code: mfrSku },
    { field: 'default_supplier_part_code', code: stockCode },
    { field: 'supplier_part_code', code: stockCode },
    { field: 'default_supplier_part_code', code: mfrSku },
  ];
  for (const { field, code } of searches) {
    if (!code) continue;
    const url = `${BASE}/api/Item?pageinate=true&page_size=5&page_no=1&includeinactive=true&advanced_search=${encodeURIComponent(JSON.stringify([{ filter_name: field, filter_type: 4, filter_value: code }]))}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!res.ok) continue;
    const data = await res.json();
    const items = data.items || data || [];
    if (Array.isArray(items) && items.length > 0) return items[0];
  }
  return null;
}

/**
 * Fetch ALL items from Halo (paginated). Used by the price audit report.
 * @returns {Promise<Array>} items with id, name, baseprice, costprice,
 *   default_supplier_part_code, supplier_part_code, qbosku
 */
export async function getAllItems() {
  const token = await getToken();
  const pageSize = 100;
  let page = 1;
  const all = [];
  while (true) {
    const url = `${BASE}/api/Item?pageinate=true&page_size=${pageSize}&page_no=${page}&includeinactive=true`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Halo list HTTP ${res.status}`);
    const data = await res.json();
    const items = data.items || data || [];
    if (!Array.isArray(items) || items.length === 0) break;
    for (const it of items) {
      all.push({
        id: it.id,
        name: it.name || '',
        baseprice: Number(it.baseprice) || 0,
        costprice: Number(it.costprice) || 0,
        default_supplier_part_code: it.default_supplier_part_code || '',
        supplier_part_code: it.supplier_part_code || '',
        qbosku: it.qbosku || '',
      });
    }
    if (items.length < pageSize) break;
    page++;
  }
  return all;
}

/**
 * List image attachments on an item (type 60 = item attachment, isimage true).
 * @returns {Promise<Array>} attachment objects
 */
async function listItemImages(itemId, token) {
  const url = `${BASE}/api/Attachment?unique_id=${itemId}&type=60&page_size=50`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
  });
  if (!res.ok) return [];
  const data = await res.json();
  const atts = data.attachments || data || [];
  return Array.isArray(atts) ? atts.filter((a) => a.isimage) : [];
}

/**
 * Delete all existing image attachments on an item so updates don't stack
 * duplicates. Non-image attachments are left alone.
 */
async function removeExistingImages(itemId, token) {
  const images = await listItemImages(itemId, token);
  for (const img of images) {
    try {
      await fetch(`${BASE}/api/Attachment/${img.id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}`, accept: 'application/json' },
      });
    } catch (e) {
      console.warn(`Failed to delete attachment ${img.id}:`, e.message);
    }
  }
  if (images.length) console.log(`[image] removed ${images.length} existing image(s) from item ${itemId}`);
}

/**
 * Upload selected images to Halo. Existing images are removed first (update case).
 * Returns the count uploaded + the attachment id of the primary image (if any).
 * @param {number|string} itemId
 * @param {string[]} urls       the selected image URLs to upload
 * @param {string|null} primaryUrl  which URL is the primary (its attachment id is returned)
 * @returns {Promise<{count: number, primaryId: number|null}>}
 */
export async function uploadSelectedImages(itemId, urls, primaryUrl) {
  if (!urls || !urls.length) return { count: 0, primaryId: null };

  const token = await getToken();
  await removeExistingImages(itemId, token);

  let count = 0;
  let primaryId = null;
  for (const url of urls) {
    try {
      const attachId = await uploadSingleImage(itemId, url, token);
      if (attachId) {
        count++;
        if (url === primaryUrl) primaryId = attachId;
      }
    } catch (e) {
      console.warn(`[image] failed to upload ${url.slice(0, 60)}: ${e.message}`);
    }
  }
  // If primary wasn't uploaded (or none specified), use the first successful one.
  if (!primaryId && count > 0) {
    const images = await listItemImages(itemId, token);
    primaryId = images[0]?.id || null;
  }
  console.log(`[image] uploaded ${count}/${urls.length}, primary=${primaryId}`);
  return { count, primaryId };
}

/**
 * Set an image as the primary image for an item.
 * @param {number|string} itemId
 * @param {number} primaryImageId  the attachment id
 */
export async function setPrimaryImage(itemId, primaryImageId) {
  const token = await getToken();
  const res = await fetch(`${BASE}/api/Item`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify([{ id: Number(itemId), primaryimageid: Number(primaryImageId) }]),
  });
  if (!res.ok) console.warn(`[image] setPrimaryImage failed: ${res.status}`);
  return res.ok;
}

/**
 * Upload a single image to Halo via the 3-step presigned S3 flow.
 * @returns {Promise<number|null>} attachment id
 */
async function uploadSingleImage(itemId, imageUrl, token) {
  const imgRes = await fetch(imageUrl);
  if (!imgRes.ok) throw new Error(`download ${imgRes.status}`);
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
  const ext = contentType.includes('png') ? 'png' : contentType.includes('webp') ? 'webp' : 'jpg';
  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
  const filesize = imgBuf.length;
  const tempid = crypto.randomUUID();

  // Step 1: get presigned URL.
  const psBody = [{ filename, filesize, _uploading: true, _tempid: tempid, type: 60, showforusers: false, showonchild: false }];
  const psRes = await fetch(`${BASE}/api/Attachment/GetS3PresignedURL?token=`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(psBody),
  });
  if (!psRes.ok) throw new Error(`GetS3PresignedURL failed: ${psRes.status}`);
  const psData = (await psRes.json()).presignedUrls?.[0];
  if (!psData) throw new Error('No presigned URL returned');
  const { url: s3Url, name: s3Name, fields } = psData;

  // Step 2: upload to S3 (multipart/form-data with all fields + file last).
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    form.append(key, value);
  }
  form.append('file', new Blob([imgBuf], { type: contentType }), s3Name);
  const s3Res = await fetch(s3Url, { method: 'POST', body: form });
  if (!s3Res.ok && s3Res.status !== 204) {
    throw new Error(`S3 upload failed: ${s3Res.status}`);
  }

  // Step 3: register the upload.
  const completeBody = [{
    originalfilename: filename, filename: s3Name, filesize,
    _tempid: tempid, type: 60, unique_id: String(itemId),
  }];
  const doneRes = await fetch(`${BASE}/api/Attachment/PresignedURLUploadComplete`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(completeBody),
  });
  if (!doneRes.ok) throw new Error(`PresignedURLUploadComplete failed: ${doneRes.status}`);
  const doneData = (await doneRes.json());
  const attachment = Array.isArray(doneData) ? doneData[0] : doneData;
  return attachment?.id || null;
}

/**
 * Build the Halo Item POST payload from a matched Leader product + chosen category.
 * @param {object} product       Leader product
 * @param {object} breakdown     pricing breakdown
 * @param {string} existingId    item id if updating
 * @param {number} assetGroupId  Halo asset group id
 * @param {object} opts          { nameOverride, keepExistingDesc }
 */
export function buildHaloPayload(product, breakdown, existingId, assetGroupId, opts = {}) {
  const category = breakdown.category;
  // Name: override if provided, otherwise the manufacturer SKU.
  const name = (opts.nameOverride || product.manufacturerSku || product.stockCode || 'Unknown').trim();
  // Description: use the override if provided, otherwise the Leader product name.
  // All three Halo description fields (description, purchase_description, user_description)
  // get the same value.
  const longDesc = cleanDesc(opts.descOverride != null ? opts.descOverride : (product.name || product.description || ''));

  const payload = {
    isitemdetails: true,
    name,
    description: longDesc,
    purchase_description: longDesc,
    user_description: longDesc,
  };
  payload.costprice = breakdown.costExGst;            // ex-GST (Leader DBP as-is)
  payload.baseprice = breakdown.retailExGst;          // ex-GST retail
  payload.secondprice = r2(breakdown.wholesale / 1.1);// ex-GST wholesale
  payload.default_supplier_part_code = product.stockCode || '';
  payload.supplier_part_code = product.manufacturerSku || '';
  payload.qbosku = product.manufacturerSku || '';     // QBO matches on manufacturer SKU
  payload.supplier_id = 33;                           // Leader Systems
  payload.manufacturer_name = product.manufacturer || '';
  payload.assetgroup_id = assetGroupId || 102;        // from the UI selector
  payload.doesnotneedconsigning = (category === 'Cables / Peripherals'
    || category === 'Printer Consumables' || category === 'Software');
  payload.dont_track_stock = false;
  payload.taxable = true;
  payload.taxcode = 5;                                // GST on sales
  payload.taxcodeother = '-1';                        // per the working curl
  payload.salestaxincluded = false;                   // ex-GST; GST added at invoice
  payload.purchasetaxincluded = false;
  payload.status = 14;                                // active
  payload.use = 'item';

  // Barcode custom field (if configured).
  const barcodeCfId = process.env.HALO_BARCODE_CF;
  if (barcodeCfId && product.barcode) {
    payload.customfields = [{ id: Number(barcodeCfId), value: product.barcode }];
  }

  // When updating an existing item, include its id.
  if (existingId) {
    payload.id = String(existingId);
  }
  // QBO linking: only when enabled. Use selected QBO item if provided, else self-link.
  if (qboEnabled()) {
    payload.linked_item_id = Number(opts.qboItemId || existingId || 0);
  }
  return payload;
}

/** Strip Leader's _x000D_ carriage markers, insert spaces after commas that lack them, tidy whitespace. */
function cleanDesc(d) {
  if (!d) return '';
  return String(d)
    .replace(/_x000D_/g, '')
    .replace(/\r/g, '')
    .replace(/,(?=[^\s])/g, ', ')   // comma not followed by a space → add one
    .trim();
}
