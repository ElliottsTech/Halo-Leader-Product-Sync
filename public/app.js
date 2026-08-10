// ─── Client-side pricing engine (so category changes re-price instantly) ───
// Must stay in sync with src/pricing.js on the server.
const TIER_BOUNDS = [5,10,20,50,100,250,500,750,1000,1250,1500,1750,2000,2250,2500,2750,3000,3250,3500,3750,4000,Number.MAX_SAFE_INTEGER];
const TIER_LABELS = ['< $5','$5–10','$10–20','$20–50','$50–100','$100–250','$250–500','$500–750','$750–1k','$1k–1.25k','$1.25k–1.5k','$1.5k–1.75k','$1.75k–2k','$2k–2.25k','$2.25k–2.5k','$2.5k–2.75k','$2.75k–3k','$3k–3.25k','$3.25k–3.5k','$3.5k–3.75k','$3.75k–4k','> $4k'];
const linear = (D,B) => { const v=[D]; for(let i=1;i<21;i++) v.push(D-(D-B)*(i/21)); v.push(B); return v; };
function cables(){const B=0.28,D=0.79,v=[0.79,0.65,0.53,0.5,0.45,0.4];[0.8,0.82,0.85,0.89,0.93,0.95,0.96,0.98,0.99,1.0].forEach(k=>v.push(D-(D-B)*k));while(v.length<22)v.push(B);return v;}
function computers(){const B=0.25,D=0.35,v=[D];[0.35,0.45,0.65,0.7,0.72,0.74,0.76,0.8,0.84,0.88,0.9,0.92,0.94,0.95,0.96,0.97,0.98,0.99,0.995,0.998].forEach(k=>v.push(D-(D-B)*k));v.push(B);return v;}
function components(){const B=0.25,D=0.35,v=[D];for(let i=1;i<=20;i++)v.push(D-(D-B)*(Math.log(1+1.5*i)/Math.log(1+1.5*21)));v.push(B);return v;}
const MARGIN_TABLE = {
    'Cables / Peripherals': cables(),
    'Computers': computers(),
    'Laptops': linear(0.35, 0.25),
    'Components': components(),
    'Printers': linear(0.38, 0.28),
    'Printer Consumables': linear(0.38, 0.28),
    'Software': linear(0.45, 0.35),
    'Unifi Products': linear(0.22, 0.12),
    'Data Recovery': linear(0.30, 0.20),
    'Staff Purchases': Array(22).fill(0.10),
};
let CATEGORIES = Object.keys(MARGIN_TABLE);
/** Rebuild the CATEGORIES list from MARGIN_TABLE (call after add/remove). */
function refreshCategories() { CATEGORIES = Object.keys(MARGIN_TABLE); }
/** Repopulate the main category dropdown + the map-editor's "add" dropdown. */
function refreshCategoryDropdowns() {
    populateCategories();
    const mapSel = $('new-map-pricing');
    if (mapSel) {
        const prev = mapSel.value;
        mapSel.innerHTML = '';
        for (const c of CATEGORIES) {
            const o = document.createElement('option');
            o.value = c; o.textContent = c;
            mapSel.appendChild(o);
        }
        if (CATEGORIES.includes(prev)) mapSel.value = prev;
    }
    // Re-render map dropdowns too (a pricing category may have been removed)
    renderCatmapDropdowns();
}
const tierFor = (c) => { for (let i=0;i<TIER_BOUNDS.length;i++) if (c<=TIER_BOUNDS[i]) return i; return 21; };
const r2 = (n) => Math.round(n*100)/100;
const money = (n) => '$' + (Math.round(n*100)/100).toLocaleString(undefined, {minimumFractionDigits: 2, maximumFractionDigits: 2});

function priceProduct(costExGst, category) {
    const cat = MARGIN_TABLE[category] ? category : 'Computers';
    const costIncGst = r2(costExGst * 1.1);
    const tier = tierFor(costIncGst);
    const margin = MARGIN_TABLE[cat][tier];
    const rawRetail = costIncGst / (1 - margin);
    const retail = Math.ceil(rawRetail);
    return {
        costExGst: r2(costExGst), costIncGst,
        tierIndex: tier, tierLabel: TIER_LABELS[tier],
        margin, marginPct: r2(margin*100),
        retail, retailExGst: r2(retail * 0.90909),
        wholesale: r2((costIncGst + retail) / 2),
        staffPrice: Math.ceil(costIncGst / 0.9),
    };
}

// ─── State ──────────────────────────────────────────────────────────────────
let currentProduct = null;   // the matched Leader product (from the server)
let currentExisting = null;  // the existing Halo item if this SKU already exists
let assetGroups = [];        // Halo asset groups [{id, name}]
let currentImageUrls = [];   // image URLs extracted from the Leader product
let primaryImageIndex = 0;   // which image is marked primary
let qboItems = [];           // QuickBooks items [{id, name, linked_item_id}]
let qboSyncEnabled = false;  // whether QBO syncing is enabled

// Suggest an asset group based on the pricing category.
const CATEGORY_TO_GROUP = {
    'Unifi Products': '⚡ Network Equipment',
    'Cables / Peripherals': '🔌 Non-serialised',
    'Components': '🛠️ Components',
    'Computers': '🖥️ Desktops',
    'Laptops': '💻 Laptops',
    'Printers': '🖨️ Peripherals',
    'Printer Consumables': '🖨️ Peripherals',
    'Software': '💿 Software',
    'Data Recovery': '👔 Professional Services',
    'Staff Purchases': '🔌 Non-serialised',
};

// ─── DOM ────────────────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);
const screens = { search: $('search'), confirm: $('confirm'), result: $('result'), audit: $('audit') };

function showScreen(name) {
    for (const s of Object.keys(screens)) screens[s].style.display = (s === name) ? '' : 'none';
    // Expand to full width when the audit report is showing.
    document.body.classList.toggle('audit-active', name === 'audit');
}
function setMsg(el, text, type) {
    el.textContent = text || '';
    el.className = 'msg' + (type ? ' ' + type : '');
}

function populateCategories() {
    const sel = $('category');
    sel.innerHTML = '';
    for (const c of CATEGORIES) {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        sel.appendChild(opt);
    }
}

function populateAssetGroups(suggestedGroupName) {
    const sel = $('asset-group');
    sel.innerHTML = '';
    for (const g of assetGroups) {
        const opt = document.createElement('option');
        opt.value = g.id; opt.textContent = g.name;
        sel.appendChild(opt);
    }
    // Auto-suggest based on the pricing category mapping.
    if (suggestedGroupName) {
        const match = assetGroups.find((g) => g.name === suggestedGroupName);
        if (match) sel.value = match.id;
    }
}

async function loadAssetGroups() {
    try {
        const res = await fetch('api/groups');
        assetGroups = await res.json();
    } catch (e) {
        console.warn('Could not load asset groups:', e.message);
        assetGroups = [];
    }
}

async function loadQboItems() {
    try {
        const res = await fetch('api/qbo-items');
        const data = await res.json();
        qboSyncEnabled = data.enabled;
        qboItems = data.items || [];
    } catch (e) {
        console.warn('Could not load QBO items:', e.message);
        qboSyncEnabled = false;
        qboItems = [];
    }
}

function populateQboItems(selectedId) {
    const row = $('qbo-row');
    const sel = $('qbo-item');
    if (!qboSyncEnabled || !qboItems.length) {
        row.style.display = 'none';
        return;
    }
    row.style.display = '';
    sel.innerHTML = '';
    // Add a "self-link (new QBO item)" option at the top.
    const selfOpt = document.createElement('option');
    selfOpt.value = '';
    selfOpt.textContent = '— Create new QBO item (self-link) —';
    sel.appendChild(selfOpt);
    for (const item of qboItems) {
        const opt = document.createElement('option');
        opt.value = item.id;
        opt.textContent = item.name;
        sel.appendChild(opt);
    }
    if (selectedId) sel.value = String(selectedId);
}

/** Collect all image URLs from the product: IMAGE field + description <img> tags. */
function collectImageUrls(product) {
    const urls = [];
    if (product.image) urls.push(product.image);
    const desc = product.description || '';
    const matches = desc.matchAll(/<img[^>]+src=['"]([^'"]+)['"]/gi);
    for (const m of matches) {
        let u = m[1].trim();
        if (u.startsWith('//')) u = 'https:' + u;
        if (u.startsWith('http') && (/\.(jpg|jpeg|png|webp|gif|bmp)/i.test(u) || u.includes('image'))) {
            urls.push(u);
        }
    }
    // De-duplicate
    return [...new Set(urls)];
}

/** Render the image picker gallery with per-image checkboxes + primary radio. */
function renderImagePicker() {
    const container = $('image-picker');
    const countEl = $('image-count');
    container.innerHTML = '';
    if (!currentImageUrls.length) {
        container.innerHTML = '<p class="meta">No images available.</p>';
        countEl.textContent = '';
        return;
    }
    countEl.textContent = `(${currentImageUrls.length} found)`;
    primaryImageIndex = 0; // default: first image is primary

    currentImageUrls.forEach((url, i) => {
        const div = document.createElement('div');
        div.className = 'img-option is-primary';
        div.innerHTML = `
            <input type="checkbox" checked data-idx="${i}" class="img-check">
            <img src="${url}" alt="Image ${i + 1}" onerror="this.style.opacity=0.3">
            <span class="primary-badge">Primary</span>
            <label class="primary-label">Set primary</label>
            <input type="radio" name="primary-img" value="${i}" ${i === 0 ? 'checked' : ''} class="primary-radio" data-idx="${i}">
        `;
        // Checkbox toggle: update visual state
        div.querySelector('.img-check').addEventListener('change', (e) => {
            div.style.opacity = e.target.checked ? '1' : '0.35';
            // If unchecking the primary, move primary to next checked
            if (!e.target.checked && div.classList.contains('is-primary')) {
                div.classList.remove('is-primary');
                const nextChecked = container.querySelector('.img-option .img-check:checked');
                if (nextChecked) {
                    const nextDiv = nextChecked.closest('.img-option');
                    nextDiv.classList.add('is-primary');
                    const radio = nextDiv.querySelector('.primary-radio');
                    radio.checked = true;
                    primaryImageIndex = Number(radio.dataset.idx);
                }
            }
        });
        // Radio toggle: update which image is primary
        div.querySelector('.primary-radio').addEventListener('change', (e) => {
            primaryImageIndex = Number(e.target.dataset.idx);
            container.querySelectorAll('.img-option').forEach(el => el.classList.remove('is-primary'));
            div.classList.add('is-primary');
        });
        container.appendChild(div);
    });
}

/** Get the selected image URLs + which one is primary (by index in the selected list). */
function getSelectedImages() {
    const container = $('image-picker');
    const checks = container.querySelectorAll('.img-check:checked');
    const selected = [];
    let primaryUrl = null;
    checks.forEach(cb => {
        const idx = Number(cb.dataset.idx);
        const url = currentImageUrls[idx];
        selected.push(url);
        if (idx === primaryImageIndex) primaryUrl = url;
    });
    // If primary was unselected, use the first selected
    if (!primaryUrl && selected.length) primaryUrl = selected[0];
    return { selected, primaryUrl };
}

function renderPricing(costExGst, category) {
    const p = priceProduct(costExGst, category);
    $('cost-ex').textContent = money(costExGst);
    $('cost-inc').textContent = money(p.costIncGst);
    $('retail').textContent = money(p.retail);
    $('retail-ex').textContent = money(p.retailExGst) + ' ex GST';
    $('wholesale').textContent = money(p.wholesale);
    $('staff').textContent = money(p.staffPrice);
    $('margin').textContent = p.marginPct + '%';
    $('tier').textContent = 'Cost tier: ' + p.tierLabel + ' (tier ' + (p.tierIndex + 1) + ' of 22)';
    return p;
}

// ─── Actions ────────────────────────────────────────────────────────────────
async function doLookup() {
    const sku = $('sku').value.trim();
    if (!sku) { setMsg($('search-msg'), 'Enter a SKU first.', 'error'); return; }
    setMsg($('search-msg'), 'Searching…');
    $('lookup').disabled = true;

    let data;
    try {
        const res = await fetch('api/lookup', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sku }),
        });
        data = await res.json();
    } catch (e) {
        setMsg($('search-msg'), 'Could not reach server: ' + e.message, 'error');
        $('lookup').disabled = false;
        return;
    }
    $('lookup').disabled = false;

    if (data.status !== 'matched') {
        setMsg($('search-msg'), data.message || 'No match found.', 'error');
        return;
    }

    // Matched — render the confirm screen
    currentProduct = data.product;
    setMsg($('search-msg'), '');
    showScreen('confirm');

    $('product-name').textContent = data.product.name || '(no name)';
    $('product-meta').textContent = [data.product.manufacturer, data.product.category].filter(Boolean).join(' · ');
    $('product-codes').textContent = [
        data.product.stockCode ? 'Leader: ' + data.product.stockCode : '',
        data.product.manufacturerSku ? 'Mfr: ' + data.product.manufacturerSku : '',
        data.product.barcode ? 'Barcode: ' + data.product.barcode : '',
    ].filter(Boolean).join('  |  ');
    const img = $('product-image');
    if (data.product.image) { img.src = data.product.image; img.style.display = ''; }
    else { img.style.display = 'none'; }

    // Build the image picker from the product's IMAGE field + description <img> tags.
    currentImageUrls = collectImageUrls(data.product);
    renderImagePicker();

    populateCategories();
    $('category').value = data.pricing.category || 'Computers';
    renderPricing(data.product.dbp, $('category').value);
    // Suggest a Halo group based on the pricing category.
    const suggestedGroup = CATEGORY_TO_GROUP[data.pricing.category] || '🔌 Non-serialised';
    populateAssetGroups(suggestedGroup);
    // Populate QBO dropdown — pre-select existing link if updating.
    populateQboItems(data.existing?.linkedItemId || null);

    // Handle existing-item (de-dupe) detection.
    currentExisting = data.existing || null;
    const warn = $('existing-warning');
    const btnAdd = $('add');
    const btnUpdate = $('add-update');
    if (currentExisting) {
        const exPrice = currentExisting.baseprice || 0;
        const incPrice = r2(exPrice * 1.1);
        warn.style.display = '';
        warn.innerHTML =
            `<strong>⚠ Already in Halo:</strong> "${currentExisting.name}" (item #${currentExisting.id}) — ` +
            `current retail $${exPrice.toFixed(2)} ex / $${incPrice.toFixed(2)} inc. ` +
            `<a href="${currentExisting.url}" target="_blank">View</a><br>` +
            `<span class="prices">Use "Update existing" to refresh prices, or "Add to Halo" to create a duplicate.</span>`;
        btnUpdate.style.display = '';
        btnAdd.textContent = 'Create duplicate';
    } else {
        warn.style.display = 'none';
        warn.innerHTML = '';
        btnUpdate.style.display = 'none';
        btnAdd.textContent = 'Add to Halo';
    }

    // Pre-fill the editable name field.
    const nameField = $('item-name');
    if (currentExisting) {
        nameField.value = currentExisting.name || data.product.manufacturerSku || '';
    } else {
        nameField.value = data.product.manufacturerSku || data.product.stockCode || '';
    }

    // Pre-fill the editable description field.
    // On create: use Leader's product name. On update: use existing Halo desc.
    const descField = $('item-desc');
    if (currentExisting) {
        descField.value = currentExisting.description || data.product.name || '';
    } else {
        descField.value = data.product.name || data.product.description || '';
    }
}

async function doConfirm(mode) {
    // mode: 'create' | 'update' | false (cancel)
    const msgEl = $('confirm-msg');
    if (!mode) { resetToSearch(); return; }

    const existingId = (mode === 'update' && currentExisting) ? currentExisting.id : null;
    setMsg(msgEl, existingId ? 'Updating item in Halo…' : 'Creating product in Halo…');
    $('add').disabled = true; $('add-update').disabled = true; $('cancel').disabled = true;

    let data;
    try {
        const res = await fetch('api/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                category: $('category').value,
                product: currentProduct,
                existingId,
                assetGroupId: Number($('asset-group').value),
                nameOverride: $('item-name').value.trim(),
                descOverride: $('item-desc').value,
                images: getSelectedImages(),
                qboItemId: qboSyncEnabled ? (Number($('qbo-item').value) || null) : null,
            }),
        });
        data = await res.json();
    } catch (e) {
        setMsg(msgEl, 'Could not reach server: ' + e.message, 'error');
        $('add').disabled = false; $('add-update').disabled = false; $('cancel').disabled = false;
        return;
    }

    if (data.status === 'created' || data.status === 'updated') {
        showScreen('result');
        const imgNote = data.imageStatus === 'uploaded' ? ' 📷 image uploaded'
            : data.imageStatus && data.imageStatus !== 'skipped' ? ` (image: ${data.imageStatus})` : '';
        $('result').innerHTML =
            `<p>${data.status === 'updated' ? '🔄' : '✅'} <strong>${data.name || 'Product'}</strong> ${data.status === 'updated' ? 'updated' : 'added to'} Halo.${imgNote}</p>` +
            `<p style="margin-top:12px;"><a href="${data.url}" target="_blank">Open in Halo →</a></p>` +
            `<p style="margin-top:16px;"><button id="again">Add another</button></p>`;
        $('again').onclick = resetToSearch;
    } else {
        setMsg(msgEl, data.message || 'Something went wrong.', 'error');
        $('add').disabled = false; $('add-update').disabled = false; $('cancel').disabled = false;
    }
}

function resetToSearch() {
    $('sku').value = '';
    setMsg($('search-msg'), '');
    setMsg($('confirm-msg'), '');
    $('add').disabled = false; $('add-update').disabled = false; $('cancel').disabled = false;
    currentProduct = null;
    currentExisting = null;
    showScreen('search');
    $('sku').focus();
}

// Re-price live when the category changes
$('category').onchange = () => {
    if (currentProduct) renderPricing(currentProduct.dbp, $('category').value);
};

// Wire up
$('lookup').onclick = doLookup;
$('add').onclick = () => doConfirm('create');
$('add-update').onclick = () => doConfirm('update');
$('cancel').onclick = () => doConfirm(false);

// ─── Search autocomplete ───────────────────────────────────────────────────
let searchTimer = null;
let searchActiveIndex = -1;
let searchResults = [];

const skuInput = $('sku');
const dropdown = $('search-dropdown');

skuInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const q = skuInput.value.trim();
    if (q.length < 2) { dropdown.style.display = 'none'; return; }
    searchTimer = setTimeout(() => doSearch(q), 200);
});

skuInput.addEventListener('keydown', (e) => {
    if (dropdown.style.display !== 'none') {
        if (e.key === 'ArrowDown') {
            e.preventDefault();
            searchActiveIndex = Math.min(searchActiveIndex + 1, searchResults.length - 1);
            highlightSearchItem();
            return;
        }
        if (e.key === 'ArrowUp') {
            e.preventDefault();
            searchActiveIndex = Math.max(searchActiveIndex - 1, 0);
            highlightSearchItem();
            return;
        }
        if (e.key === 'Enter' && searchActiveIndex >= 0 && searchResults[searchActiveIndex]) {
            e.preventDefault();
            selectSearchItem(searchResults[searchActiveIndex]);
            return;
        }
        if (e.key === 'Escape') { dropdown.style.display = 'none'; return; }
    }
    if (e.key === 'Enter') doLookup();
});

// Hide dropdown when clicking outside
document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-row')) dropdown.style.display = 'none';
});

async function doSearch(q) {
    try {
        const res = await fetch('api/search?q=' + encodeURIComponent(q));
        searchResults = await res.json();
    } catch (e) {
        searchResults = [];
    }
    searchActiveIndex = -1;
    renderSearchDropdown(searchResults);
}

function renderSearchDropdown(results) {
    if (!results.length) { dropdown.style.display = 'none'; return; }
    dropdown.innerHTML = '';
    for (const item of results) {
        const div = document.createElement('div');
        div.className = 'search-item';
        div.innerHTML = `<div class="si-name">${item.name.slice(0, 70)}</div>` +
            `<div class="si-meta">${[item.stockCode, item.manufacturerSku, item.barcode].filter(Boolean).join(' · ')} · $${item.dbp}</div>`;
        div.addEventListener('click', () => selectSearchItem(item));
        dropdown.appendChild(div);
    }
    dropdown.style.display = '';
}

function highlightSearchItem() {
    const items = dropdown.querySelectorAll('.search-item');
    items.forEach((el, i) => el.classList.toggle('active', i === searchActiveIndex));
    if (searchActiveIndex >= 0 && items[searchActiveIndex]) {
        items[searchActiveIndex].scrollIntoView({ block: 'nearest' });
    }
}

function selectSearchItem(item) {
    skuInput.value = item.manufacturerSku || item.stockCode;
    dropdown.style.display = 'none';
    doLookup();
}

// ─── Price Audit ───────────────────────────────────────────────────────────
$('run-audit').onclick = runAudit;
$('audit-back').onclick = () => showScreen('search');

/** Make table columns resizable by dragging the handle on each header. */
function makeColumnsResizable(table) {
    const handles = table.querySelectorAll('th .resize-handle');
    handles.forEach((handle) => {
        const th = handle.parentElement;
        handle.addEventListener('mousedown', (e) => {
            e.preventDefault();
            const startX = e.pageX;
            const startWidth = th.offsetWidth;
            const colIndex = Array.from(th.parentNode.children).indexOf(th);
            const doDrag = (ev) => {
                const newWidth = Math.max(40, startWidth + ev.pageX - startX);
                th.style.width = newWidth + 'px';
                // Apply width to all cells in this column
                table.querySelectorAll(`tr td:nth-child(${colIndex + 1})`).forEach((td) => {
                    td.style.width = newWidth + 'px';
                });
            };
            const stopDrag = () => {
                document.removeEventListener('mousemove', doDrag);
                document.removeEventListener('mouseup', stopDrag);
            };
            document.addEventListener('mousemove', doDrag);
            document.addEventListener('mouseup', stopDrag);
        });
    });
}

async function runAudit() {
    showScreen('audit');
    $('audit-loading').style.display = '';
    $('audit-table').innerHTML = '';
    $('audit-summary').textContent = '';

    let data;
    try {
        const res = await fetch('api/audit');
        data = await res.json();
    } catch (e) {
        $('audit-loading').textContent = 'Error: ' + e.message;
        return;
    }
    $('audit-loading').style.display = 'none';
    $('audit-summary').textContent = `${data.matched} of ${data.total} Halo items matched to Leader`;

    const tbl = $('audit-table');
    // Column order: Item, Leader SKU, Leader desc, Leader cost, Halo cost, Cost Δ,
    //               Proposed retail, Halo retail, Retail Δ, Action
    const headers = ['Item', 'Leader SKU', 'Leader description', 'Leader cost', 'Halo cost (ex)', 'Cost Δ', 'Proposed retail (ex)', 'Halo retail (ex)', 'Retail Δ', ''];
    // Default widths (px) — narrow for numbers, wider for text. Description gets the flex remainder.
    const colWidths = [null, 120, null, 90, 100, 70, 130, 100, 70, 70];
    const head = document.createElement('tr');
    headers.forEach((h, i, arr) => {
        const th = document.createElement('th');
        th.textContent = h;
        if (colWidths[i]) th.style.width = colWidths[i] + 'px';
        if (i < arr.length - 1) {
            const handle = document.createElement('div');
            handle.className = 'resize-handle';
            th.appendChild(handle);
        }
        head.appendChild(th);
    });
    tbl.appendChild(head);
    makeColumnsResizable(tbl);

    // Sort by retail deviation (largest drift first)
    const items = data.items.sort((a, b) => Math.abs(b.deviation.pricePct || 0) - Math.abs(a.deviation.pricePct || 0));

    for (const item of items) {
        const tr = document.createElement('tr');
        const pPct = item.deviation.pricePct;
        const cPct = item.deviation.costPct;
        // Row colour based on retail delta: red = proposed higher than current, green = lower, white = no change.
        if (pPct != null && pPct > 0.1) tr.className = 'deviation-down';
        else if (pPct != null && pPct < -0.1) tr.className = 'deviation-up';

        const cells = [
            { text: item.halo.name, title: item.leader.stockCode || '' },
            { text: item.leader.manufacturerSku || item.leader.stockCode || '' },
            { text: item.leader.name || '', wrap: true },
            { num: '$' + item.leader.dbp.toFixed(2) },
            { num: '$' + item.halo.currentCost.toFixed(2) },
            { num: (cPct != null ? (cPct > 0 ? '+' : '') + cPct + '%' : '—'), cls: cPct > 0 ? 'delta-pos' : (cPct < 0 ? 'delta-neg' : '') },
            { num: '$' + item.proposed.retailEx.toFixed(2) },
            { num: '$' + item.halo.currentRetail.toFixed(2) },
            { num: (pPct != null ? (pPct > 0 ? '+' : '') + pPct + '%' : '—'), cls: pPct > 0 ? 'delta-pos' : (pPct < 0 ? 'delta-neg' : '') },
        ];
        for (const c of cells) {
            const td = document.createElement('td');
            if (c.num) { td.className = 'num'; td.textContent = c.num; }
            else {
                td.textContent = c.text;
                if (c.title) td.title = c.title;
                if (c.wrap) td.classList.add('wrap-cell');
            }
            if (c.cls) td.classList.add(c.cls);
            tr.appendChild(td);
        }
        // Update button
        const tdBtn = document.createElement('td');
        const btn = document.createElement('button');
        btn.className = 'update-btn';
        btn.textContent = 'Update';
        btn.onclick = () => {
            $('sku').value = item.leader.manufacturerSku || item.leader.stockCode;
            showScreen('search');
            doLookup();
        };
        tdBtn.appendChild(btn);
        tr.appendChild(tdBtn);
        tbl.appendChild(tr);
    }
}

// ─── Leader → pricing category map ──────────────────────────────────────────
let CATEGORY_MAP = {};

async function loadCategoryMap() {
    try {
        const res = await fetch('api/category-map');
        CATEGORY_MAP = await res.json();
    } catch (e) {
        console.warn('Could not load category map:', e.message);
        CATEGORY_MAP = {};
    }
}

function renderCatmapTable() {
    const tbl = $('catmap-table');
    tbl.innerHTML = '';
    $('catmap-summary').textContent = `Leader category mapping (${Object.keys(CATEGORY_MAP).length} mapped)`;
    // header
    const thead = document.createElement('tr');
    ['Leader category', 'Pricing category', ''].forEach((h) => {
        const th = document.createElement('th');
        th.textContent = h;
        thead.appendChild(th);
    });
    tbl.appendChild(thead);
    // rows (sorted by Leader category name)
    const keys = Object.keys(CATEGORY_MAP).sort((a, b) => a.localeCompare(b));
    for (const leaderCat of keys) {
        const tr = document.createElement('tr');
        const tdName = document.createElement('td');
        tdName.className = 'leader-name';
        tdName.textContent = leaderCat;
        tr.appendChild(tdName);
        const tdSel = document.createElement('td');
        const sel = document.createElement('select');
        sel.dataset.leader = leaderCat;
        for (const c of CATEGORIES) {
            const o = document.createElement('option');
            o.value = c; o.textContent = c;
            if (c === CATEGORY_MAP[leaderCat]) o.selected = true;
            sel.appendChild(o);
        }
        sel.addEventListener('change', onCatmapChange);
        tdSel.appendChild(sel);
        tr.appendChild(tdSel);
        const tdRm = document.createElement('td');
        const rm = document.createElement('button');
        rm.className = 'map-remove';
        rm.textContent = 'Remove';
        rm.onclick = () => removeMapRow(leaderCat);
        tdRm.appendChild(rm);
        tr.appendChild(tdRm);
        tbl.appendChild(tr);
    }
}

/** Update dropdown options in the map table (after pricing categories change). */
function renderCatmapDropdowns() {
    document.querySelectorAll('#catmap-table select').forEach((sel) => {
        const leader = sel.dataset.leader;
        const cur = sel.value;
        sel.innerHTML = '';
        for (const c of CATEGORIES) {
            const o = document.createElement('option');
            o.value = c; o.textContent = c;
            if (c === (CATEGORY_MAP[leader] || cur)) o.selected = true;
            sel.appendChild(o);
        }
    });
}

function onCatmapChange(e) {
    CATEGORY_MAP[e.target.dataset.leader] = e.target.value;
    scheduleCatmapSave();
}

async function removeMapRow(leaderCat) {
    delete CATEGORY_MAP[leaderCat];
    renderCatmapTable();
    scheduleCatmapSave();
}

let catmapSaveTimer = null;
function scheduleCatmapSave() {
    clearTimeout(catmapSaveTimer);
    setMsg($('catmap-msg'), 'Saving…');
    catmapSaveTimer = setTimeout(async () => {
        try {
            const res = await fetch('api/category-map', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(CATEGORY_MAP),
            });
            const data = await res.json();
            if (data.status === 'saved') {
                setMsg($('catmap-msg'), 'Saved ✓', 'success');
                setTimeout(() => setMsg($('catmap-msg'), ''), 1500);
            } else {
                setMsg($('catmap-msg'), data.message || 'Save failed.', 'error');
            }
        } catch (e) {
            setMsg($('catmap-msg'), 'Save failed: ' + e.message, 'error');
        }
    }, 600);
}

// Add a new mapping row
$('add-map-row-btn').onclick = () => {
    const leader = $('new-map-leader').value.trim();
    const pricing = $('new-map-pricing').value;
    if (!leader) { setMsg($('catmap-msg'), 'Enter a Leader category name.', 'error'); return; }
    CATEGORY_MAP[leader] = pricing;
    $('new-map-leader').value = '';
    renderCatmapTable();
    scheduleCatmapSave();
};

/**
 * Load the saved margin table (for pricing) + category map.
 * The category-map editor is shown when ?margins=1.
 * (Margin table editing is on the /price-calc page now.)
 */
async function initMargins() {
    // Pull the saved margin table so pricing reflects any prior edits.
    try {
        const res = await fetch('api/margins');
        const saved = await res.json();
        if (saved && typeof saved === 'object') {
            for (const k of Object.keys(MARGIN_TABLE)) delete MARGIN_TABLE[k];
            for (const [k, v] of Object.entries(saved)) {
                if (Array.isArray(v) && v.length === 22) MARGIN_TABLE[k] = v;
            }
            refreshCategories();
        }
    } catch (e) {
        console.warn('Could not load saved margins, using defaults:', e.message);
    }

    // Always load + render the category map (read-only by default).
    await loadCategoryMap();
    renderCatmapTable();
    refreshCategoryDropdowns();
    setCatmapEditable(false);
}

// ─── Edit toggle (password-gated) for category map ─────────────────────────
let editUnlocked = false;

$('edit-toggle').onclick = async () => {
    if (editUnlocked) {
        editUnlocked = false;
        $('edit-toggle').textContent = '🔒 Edit';
        $('edit-toggle').classList.remove('unlocked');
        setCatmapEditable(false);
        return;
    }
    const pw = prompt('Enter edit password:');
    if (!pw) return;
    try {
        const res = await fetch('api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
        });
        const data = await res.json();
        if (data.ok) {
            editUnlocked = true;
            $('edit-toggle').textContent = '🔓 Locked';
            $('edit-toggle').classList.add('unlocked');
            setCatmapEditable(true);
            setMsg($('catmap-msg'), '', '');
        } else {
            setMsg($('catmap-msg'), 'Incorrect password.', 'error');
        }
    } catch (e) {
        setMsg($('catmap-msg'), 'Error: ' + e.message, 'error');
    }
};

function setCatmapEditable(on) {
    document.querySelectorAll('#catmap-table select').forEach(el => el.disabled = !on);
    document.querySelectorAll('.map-remove').forEach(el => el.disabled = !on);
    $('add-map-row').style.display = on ? '' : 'none';
}

populateCategories();
showScreen('search');
loadAssetGroups();
loadQboItems();
initMargins();

// ─── Auto-update from URL param: ?update=[barcode] ─────────────────────────
// When Halo's "Update from Leader" button links here with a barcode,
// auto-fill the search box and submit the lookup immediately.
(function checkUpdateParam() {
    const params = new URLSearchParams(window.location.search);
    if (params.has('update')) {
        const barcode = params.get('update');
        if (!barcode || !barcode.trim()) {
            setMsg($('search-msg'), 'No barcode is set in this Halo item. Go back, set a barcode on the item, then try again.', 'error');
            return;
        }
        $('sku').value = barcode.trim();
        doLookup();
    }
})();
