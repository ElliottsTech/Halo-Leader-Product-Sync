/**
 * Leader data feed: download + parse the catalogue CSV.
 *
 * The feed is a quoted CSV (~20MB, ~19,800 products) with multi-line long
 * descriptions. We stream-parse it directly from the response buffer — no
 * temp files, no external CSV library.
 */

const FEED_URL = (customerCode) =>
  `https://partner.leadersystems.com.au/WSDataFeed.asmx/DownLoad`
  + `?CustomerCode=${encodeURIComponent(customerCode)}`
  + `&WithHeading=true&WithLongDescription=true&DataType=7`;

/**
 * Download the feed and parse it into product rows.
 * @returns {Promise<Array<object>>} parsed rows
 */
export async function fetchCatalogue() {
  const code = process.env.LEADER_CUSTOMER_CODE;
  if (!code) throw new Error('LEADER_CUSTOMER_CODE not set in .env');

  const url = FEED_URL(code);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Leader feed HTTP ${res.status} ${res.statusText}`);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  return parseFeed(buf);
}

/**
 * Streaming CSV parser — scans a Buffer of quoted CSV bytes and returns
 * product row objects keyed by the header names we care about.
 *
 * Handles quoted fields, embedded commas, escaped quotes (""), and
 * embedded newlines inside quoted fields (the long-description case).
 * @param {Buffer} buf
 * @returns {Array<object>}
 */
export function parseFeed(buf) {
  let i = 0, n = buf.length, field = '', row = [], inQ = false, fStart = false;
  let headers = null;
  const rows = [];

  while (i < n) {
    const ch = buf[i];
    if (inQ) {
      if (ch === 0x22) {                       // "
        if (buf[i + 1] === 0x22) { field += '"'; i += 2; continue; }  // escaped ""
        inQ = false; i++; continue;
      }
      let j = i;
      while (j < n && buf[j] !== 0x22) j++;
      field += buf.slice(i, j).toString('utf8');
      i = j;
      continue;
    }
    if (ch === 0x22) { inQ = true; fStart = true; i++; continue; }
    if (ch === 0x2c) { row.push(field); field = ''; fStart = false; i++; continue; }   // ,
    if (ch === 0x0d) { i++; continue; }                                              // CR
    if (ch === 0x0a) {                                                               // LF = end of record
      row.push(field);
      if (!headers) {
        headers = row;
      } else {
        rows.push(rowToObject(row, headers));
      }
      row = []; field = ''; fStart = false; i++; continue;
    }
    let j = i;
    while (j < n) { const cc = buf[j]; if (cc === 0x22 || cc === 0x2c || cc === 0x0d || cc === 0x0a) break; j++; }
    field += buf.slice(i, j).toString('utf8');
    fStart = true;
    i = j;
  }
  // trailing record (no final newline)
  if (fStart || row.length) {
    row.push(field);
    if (!headers) headers = row;
    else rows.push(rowToObject(row, headers));
  }
  return rows;
}

function rowToObject(row, headers) {
  const idx = {};
  headers.forEach((h, k) => { idx[h] = k; });
  const get = (h) => (idx[h] != null ? (row[idx[h]] || '').trim() : '');
  return {
    stockCode: get('STOCK CODE'),
    manufacturerSku: get('MANUFACTURER SKU'),
    barcode: get('BAR CODE'),
    name: get('SHORT DESCRIPTION'),
    description: get('LONG DESCRIPTION') || get('SHORT DESCRIPTION'),
    image: get('IMAGE'),
    category: get('CATEGORY NAME'),
    manufacturer: get('MANUFACTURER'),
    dbp: parseFloat(get('DBP') || 0),
    rrp: parseFloat(get('RRP') || 0),
  };
}
