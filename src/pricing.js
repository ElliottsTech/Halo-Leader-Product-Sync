/**
 * Leader → Halo pricing engine.
 *
 * Ported from "Automated Price Check For Halo V1.xlsx" (Price Calculator sheet).
 * The 10-category × 22-cost-tier margin table is reproduced programmatically
 * from the original Excel formulas and verified against the cached workbook.
 *
 * Pricing rules (Australian, GST inclusive):
 *   costExGst  = Leader DBP            (what you paid, before tax)
 *   costIncGst = costExGst × 1.1
 *   margin%    = marginTable[category][tier]   (tier chosen by costIncGst)
 *   rawRetail  = costIncGst ÷ (1 − margin)
 *   retail     = CEILING(rawRetail, 1)         (round up to nearest $1)
 *   retailEx   = retail × 0.90909              (≈ retail ÷ 1.1)
 *   wholesale  = (costIncGst + retail) ÷ 2     (midpoint)
 *   staffPrice = CEILING(costIncGst ÷ (1 − 0.10), 1)
 */

// ─── Cost tiers ────────────────────────────────────────────────────────────
export const TIER_BOUNDS = [
  5, 10, 20, 50, 100, 250, 500, 750, 1000, 1250, 1500, 1750, 2000,
  2250, 2500, 2750, 3000, 3250, 3500, 3750, 4000, Number.MAX_SAFE_INTEGER,
];

export const TIER_LABELS = [
  '< $5', '$5–10', '$10–20', '$20–50', '$50–100', '$100–250', '$250–500',
  '$500–750', '$750–1k', '$1k–1.25k', '$1.25k–1.5k', '$1.5k–1.75k',
  '$1.75k–2k', '$2k–2.25k', '$2.25k–2.5k', '$2.5k–2.75k', '$2.75k–3k',
  '$3k–3.25k', '$3.25k–3.5k', '$3.5k–3.75k', '$3.75k–4k', '> $4k',
];

/** Find the tier index (0-21) for a given inc-GST cost. */
export function tierFor(costIncGst) {
  for (let i = 0; i < TIER_BOUNDS.length; i++) {
    if (costIncGst <= TIER_BOUNDS[i]) return i;
  }
  return TIER_BOUNDS.length - 1;
}

// ─── Margin table generators ───────────────────────────────────────────────
function linear(D, B) {
  const v = [D];
  for (let i = 1; i < 21; i++) v.push(D - (D - B) * (i / 21));
  v.push(B);
  return v;
}
function cables() {
  const B = 0.28, D = 0.79;
  const v = [0.79, 0.65, 0.53, 0.5, 0.45, 0.4];
  [0.8, 0.82, 0.85, 0.89, 0.93, 0.95, 0.96, 0.98, 0.99, 1.0].forEach((k) => v.push(D - (D - B) * k));
  while (v.length < 22) v.push(B);
  return v;
}
function computers() {
  const B = 0.25, D = 0.35;
  const v = [D];
  [0.35, 0.45, 0.65, 0.7, 0.72, 0.74, 0.76, 0.8, 0.84, 0.88,
    0.9, 0.92, 0.94, 0.95, 0.96, 0.97, 0.98, 0.99, 0.995, 0.998].forEach((k) => v.push(D - (D - B) * k));
  v.push(B);
  return v;
}
function components() {
  const B = 0.25, D = 0.35;
  const v = [D];
  for (let i = 1; i <= 20; i++) {
    v.push(D - (D - B) * (Math.log(1 + 1.5 * i) / Math.log(1 + 1.5 * 21)));
  }
  v.push(B);
  return v;
}

// ─── The margin table ──────────────────────────────────────────────────────
// Mutable at runtime: categories can be added/removed, margins edited.
const DEFAULT_MARGINS = () => ({
  'Cables / Peripherals': cables(),
  'Computers':            computers(),
  'Laptops':              linear(0.35, 0.25),
  'Components':           components(),
  'Printers':             linear(0.38, 0.28),
  'Printer Consumables':  linear(0.38, 0.28),
  'Software':             linear(0.45, 0.35),
  'Unifi Products':       linear(0.22, 0.12),
  'Data Recovery':        linear(0.30, 0.20),
  'Staff Purchases':      Array(22).fill(0.10),
});

export const MARGIN_TABLE = DEFAULT_MARGINS();

/** Current list of pricing categories (call fresh — it can change at runtime). */
export function getCategories() { return Object.keys(MARGIN_TABLE); }

/**
 * Replace the margin table wholesale. Categories may be added or removed vs
 * the defaults; each must be an array of 22 numbers in [0, 1].
 * @param {object} table  { 'Category': [0..1 × 22] }
 */
export function setMargins(table) {
  if (!table || typeof table !== 'object') throw new Error('Invalid margin table');
  const next = {};
  for (const [key, row] of Object.entries(table)) {
    if (!Array.isArray(row) || row.length !== 22) {
      throw new Error(`Category "${key}" must have 22 values`);
    }
    next[key] = row.map((v) => {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new Error(`Invalid margin for "${key}": ${v} (must be 0..1)`);
      }
      return n;
    });
  }
  // Replace contents in place so other module references stay valid.
  for (const k of Object.keys(MARGIN_TABLE)) delete MARGIN_TABLE[k];
  for (const [k, v] of Object.entries(next)) MARGIN_TABLE[k] = v;
}

/** Add a new pricing category with a flat margin across all 22 tiers. */
export function addCategory(name, flatMargin = 0.25) {
  name = String(name || '').trim();
  if (!name) throw new Error('Category name required');
  if (MARGIN_TABLE[name]) throw new Error(`Category "${name}" already exists`);
  const n = Number(flatMargin);
  if (!Number.isFinite(n) || n < 0 || n > 1) throw new Error('margin must be 0..1');
  MARGIN_TABLE[name] = Array(22).fill(n);
}

/** Remove a pricing category. */
export function removeCategory(name) {
  if (!MARGIN_TABLE[name]) throw new Error(`Category "${name}" not found`);
  if (Object.keys(MARGIN_TABLE).length <= 1) throw new Error('Cannot remove the last category');
  delete MARGIN_TABLE[name];
}

/** Return a plain copy of the current margin table (for the API). */
export function getMargins() {
  const out = {};
  for (const [k, v] of Object.entries(MARGIN_TABLE)) out[k] = v.slice();
  return out;
}

// ─── Leader → pricing category map ─────────────────────────────────────────
// Explicit mapping from Leader's CATEGORY NAME values to a pricing category.
// Built from the 82 distinct categories observed in the feed. Editable via API.
const DEFAULT_CATEGORY_MAP = {
  'Network - UniFi': 'Unifi Products',
  'Network - UISP': 'Unifi Products',
  'Network - Security UTM': 'Unifi Products',
  'Network - Consumer': 'Unifi Products',
  'Network - SMB': 'Unifi Products',
  'VOIP Phones': 'Unifi Products',
  'VOIP Headsets': 'Cables / Peripherals',
  'VOIP Gateways': 'Unifi Products',
  'Cables': 'Cables / Peripherals',
  'USB, Bluetooth & IEEE': 'Cables / Peripherals',
  'KVM Switch & Video': 'Cables / Peripherals',
  'UPS & Power Board': 'Cables / Peripherals',
  'Mouse': 'Cables / Peripherals',
  'Keyboards': 'Cables / Peripherals',
  'Web Cams': 'Cables / Peripherals',
  'Speakers, Headsets & Mic': 'Cables / Peripherals',
  'Desk Cable Management': 'Cables / Peripherals',
  'Chargers - Mobile Devices': 'Cables / Peripherals',
  'Power Banks': 'Cables / Peripherals',
  'Cases & Accessories': 'Cables / Peripherals',
  'Mobile Phone Cases': 'Cables / Peripherals',
  'Mobile Phone Accessories': 'Cables / Peripherals',
  'Mobile Screen Protectors': 'Cables / Peripherals',
  'iPad, Tablet & Surface Cases': 'Cables / Peripherals',
  'iPad, Tablet & Surface Screen Protectors': 'Cables / Peripherals',
  'iPad, Tablet & Surface Keyboard': 'Cables / Peripherals',
  'Magsafe Accessories': 'Cables / Peripherals',
  'MacBook Accessories': 'Cables / Peripherals',
  'Presentation Remote': 'Cables / Peripherals',
  'Pens & Pencils': 'Cables / Peripherals',
  'Notebooks': 'Laptops',
  'Notebooks/2-in-1 - LEADER': 'Laptops',
  'Notebooks - Resistance': 'Laptops',
  'Notebook Accessories': 'Laptops',
  'Memory': 'Components',
  'Hard Disk Drives - SSD': 'Components',
  'Hard Disk Drives - SATA': 'Components',
  'Hard Drives - External': 'Components',
  'Flash Memory': 'Components',
  'Video/Graphics Cards': 'Components',
  'Motherboards': 'Components',
  'CPU': 'Components',
  'Power Supplies': 'Components',
  'Fan & Cooling Products': 'Components',
  'RAID Controllers, Cables & Accessories': 'Components',
  'I/O PCI / PCIe Devices': 'Components',
  'DVD & Bluray Drives': 'Components',
  'CDR/RW & DVDR/RW  Media': 'Components',
  'Servers': 'Computers',
  'Systems - NUC/SFF/AIO': 'Computers',
  'Systems NUC/PC-Stick/AIO (Leader)': 'Computers',
  'Systems - Desktop (Leader)': 'Computers',
  'Monitors': 'Computers',
  'Monitor Arms (VESA)': 'Computers',
  'Commercial Display': 'Computers',
  'Projectors': 'Computers',
  'Commercial Projectors': 'Computers',
  'Backup, NAS & Storage': 'Computers',
  'Data Racks & Accessories': 'Computers',
  'Other Hardware': 'Computers',
  'Furniture': 'Computers',
  'Printer Hardware': 'Printers',
  'Scanner and Labeller': 'Printers',
  'Labelling & Mobility Solutions': 'Printers',
  'Point of Sale': 'Printers',
  'Printer Consumable': 'Printer Consumables',
  'Software': 'Software',
  'Software Licensing': 'Software',
  'Onsite Warranty': 'Software',
  'Leader Professional Services': 'Data Recovery',
  'LEADER - spare parts': 'Cables / Peripherals',
  'IoT / LTE': 'Unifi Products',
  'Smart Watches': 'Cables / Peripherals',
  'Smart Watch Case and Screen Protector': 'Cables / Peripherals',
  'Tablets': 'Cables / Peripherals',
  'Mobile Phones': 'Cables / Peripherals',
  'Samsung Galaxy Knox': 'Cables / Peripherals',
  'Video Conferencing': 'Unifi Products',
  'Security and Surveillance': 'Unifi Products',
  'Home Automation': 'Cables / Peripherals',
  'Car Accessories': 'Cables / Peripherals',
  'Trimate AI Bots (Chat & Voice)': 'Software',
};

export const CATEGORY_MAP = { ...DEFAULT_CATEGORY_MAP };

export function getCategoryMap() { return { ...CATEGORY_MAP }; }
export function setCategoryMap(m) {
  if (!m || typeof m !== 'object') throw new Error('Invalid category map');
  for (const k of Object.keys(CATEGORY_MAP)) delete CATEGORY_MAP[k];
  for (const [k, v] of Object.entries(m)) CATEGORY_MAP[String(k)] = String(v);
}

// ─── Category mapping (map → keyword fallback → default) ───────────────────
const DEFAULT_CATEGORY = () => Object.keys(MARGIN_TABLE)[0] || 'Computers';

export function mapCategory(leaderCategoryName = '', manufacturer = '', name = '') {
  // 1. Explicit Leader category-name map (exact, case-insensitive).
  const lc = String(leaderCategoryName || '').trim().toLowerCase();
  for (const [key, val] of Object.entries(CATEGORY_MAP)) {
    if (key.toLowerCase() === lc && MARGIN_TABLE[val]) return val;
  }
  // 2. Keyword fallback (for unmatched category names).
  const hay = `${leaderCategoryName} ${manufacturer} ${name}`.toLowerCase();
  if (/unifi|ubiquiti|nanostation|dream machine|udm|usw|u6|u7|uap|gateway|flex switch/.test(hay)) return 'Unifi Products';
  if (/laptop|notebook|ultrabook|chromebook|2-in-1|macbook/.test(hay)) return 'Laptops';
  if (/toner|ink cartridge|drum|ribbon|consumable/.test(hay)) return 'Printer Consumables';
  if (/printer|inkjet|laser|multifunction|label printer/.test(hay)) return 'Printers';
  if (/cable|adapter|mouse|keyboard|usb|hub|surge|ups|headset|webcam|peripheral/.test(hay)) return 'Cables / Peripherals';
  if (/ssd|hdd|ram|memory|gpu|cpu|motherboard|psu|power supply|case|cooler|component/.test(hay)) return 'Components';
  if (/desktop|workstation|all-in-one|pc\b|tower/.test(hay)) return 'Computers';
  if (/windows|office|antivirus|software|license|subscription/.test(hay)) return 'Software';
  if (/recovery|forensic|backup service/.test(hay)) return 'Data Recovery';
  // 3. Default.
  return DEFAULT_CATEGORY();
}

// ─── Core pricing ──────────────────────────────────────────────────────────
const GST_RATE = 0.10;
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * Compute the full price breakdown for a product.
 * @param {number} costExGst      Leader DBP (Dealer Base Price), excluding GST
 * @param {string} category       One of CATEGORIES
 * @returns {object} breakdown with all price points + the applied margin/tier
 */
export function priceProduct(costExGst, category) {
  const cat = MARGIN_TABLE[category] ? category : 'Computers';
  const costIncGst = round2(costExGst * (1 + GST_RATE));
  const tier = tierFor(costIncGst);
  const margin = MARGIN_TABLE[cat][tier];
  const rawRetail = costIncGst / (1 - margin);
  const retail = Math.ceil(rawRetail);
  const wholesale = round2((costIncGst + retail) / 2);
  return {
    costExGst: round2(costExGst),
    costIncGst,
    category: cat,
    tierIndex: tier,
    tierLabel: TIER_LABELS[tier],
    margin,
    marginPct: round2(margin * 100),
    rawRetail: round2(rawRetail),
    retail,
    retailExGst: round2(retail * 0.90909),
    wholesale,
    maxDiscount: round2((retail + wholesale) / 2),
    staffPrice: Math.ceil(costIncGst / 0.9),
    profitPerUnit: round2(retail - costIncGst),
    wholesaleProfit: round2(wholesale - costIncGst),
  };
}
