// ─── Pricing engine (must stay in sync with src/pricing.js) ──────────────
const TIER_BOUNDS = [5,10,20,50,100,250,500,750,1000,1250,1500,1750,2000,2250,2500,2750,3000,3250,3500,3750,4000,Number.MAX_SAFE_INTEGER];
const TIER_LABELS = ['< $5','$5-10','$10-20','$20-50','$50-100','$100-250','$250-500','$500-750','$750-1k','$1k-1.25k','$1.25k-1.5k','$1.5k-1.75k','$1.75k-2k','$2k-2.25k','$2.25k-2.5k','$2.5k-2.75k','$2.75k-3k','$3k-3.25k','$3.25k-3.5k','$3.5k-3.75k','$3.75k-4k','> $4k'];
const linear = (D,B) => { const v=[D]; for(let i=1;i<21;i++) v.push(D-(D-B)*(i/21)); v.push(B); return v; };
function cables(){const B=0.28,D=0.79,v=[0.79,0.65,0.53,0.5,0.45,0.4];[0.8,0.82,0.85,0.89,0.93,0.95,0.96,0.98,0.99,1.0].forEach(k=>v.push(D-(D-B)*k));while(v.length<22)v.push(B);return v;}
function computers(){const B=0.25,D=0.35,v=[D];[0.35,0.45,0.65,0.7,0.72,0.74,0.76,0.8,0.84,0.88,0.9,0.92,0.94,0.95,0.96,0.97,0.98,0.99,0.995,0.998].forEach(k=>v.push(D-(D-B)*k));v.push(B);return v;}
function components(){const B=0.25,D=0.35,v=[D];for(let i=1;i<=20;i++)v.push(D-(D-B)*(Math.log(1+1.5*i)/Math.log(1+1.5*21)));v.push(B);return v;}
let MARGIN_TABLE = {
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
function refreshCategories() { CATEGORIES = Object.keys(MARGIN_TABLE); }
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

// ─── DOM helpers ───────────────────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function populateCategories() {
    const sel = $('category');
    const prev = sel.value;
    sel.innerHTML = '';
    for (const c of CATEGORIES) {
        const opt = document.createElement('option');
        opt.value = c; opt.textContent = c;
        sel.appendChild(opt);
    }
    if (CATEGORIES.includes(prev)) sel.value = prev;
}

// ─── Linked ex/inc GST inputs + price calculation ──────────────────────────
let updatingLinked = false;

function calcFromEx() {
    if (updatingLinked) return;
    const ex = parseFloat($('cost-ex').value) || 0;
    updatingLinked = true;
    $('cost-inc').value = r2(ex * 1.1).toFixed(2);
    updatingLinked = false;
    renderPricing(ex);
}

function calcFromInc() {
    if (updatingLinked) return;
    const inc = parseFloat($('cost-inc').value) || 0;
    const ex = r2(inc / 1.1);
    updatingLinked = true;
    $('cost-ex').value = ex.toFixed(2);
    updatingLinked = false;
    renderPricing(ex);
}

function renderPricing(costExGst) {
    const cat = $('category').value || 'Computers';
    const p = priceProduct(costExGst, cat);
    $('retail').textContent = money(p.retail);
    $('retail-ex').textContent = money(p.retailExGst) + ' ex GST';
    $('wholesale').textContent = money(p.wholesale);
    $('staff').textContent = money(p.staffPrice);
    $('margin').textContent = p.marginPct + '%';
    $('tier').textContent = 'Cost tier: ' + p.tierLabel + ' (tier ' + (p.tierIndex + 1) + ' of 22)';
}

$('cost-ex').addEventListener('input', calcFromEx);
$('cost-inc').addEventListener('input', calcFromInc);
$('category').addEventListener('change', () => renderPricing(parseFloat($('cost-ex').value) || 0));

// ─── Margin table (read-only by default, edit with password) ──────────────
const TIER_COLS = ['<$5','$5','$10','$20','$50','$100','$250','$500','$750','$1k',
  '$1.25k','$1.5k','$1.75k','$2k','$2.25k','$2.5k','$2.75k','$3k','$3.25k',
  '$3.5k','$3.75k','$4k+'];

function renderMarginTable() {
    const tbl = $('margin-table');
    tbl.innerHTML = '';
    $('margin-summary').textContent = 'Margin tiers (' + CATEGORIES.length + ' categories x 22 cost tiers)';
    const thead = document.createElement('tr');
    const corner = document.createElement('th');
    corner.className = 'row-label';
    corner.textContent = 'Category';
    thead.appendChild(corner);
    TIER_COLS.forEach(function(t) {
        const th = document.createElement('th');
        th.textContent = t;
        thead.appendChild(th);
    });
    tbl.appendChild(thead);
    for (const cat of CATEGORIES) {
        const tr = document.createElement('tr');
        const label = document.createElement('td');
        label.className = 'row-label';
        const span = document.createElement('span');
        span.textContent = cat;
        label.appendChild(span);
        const rm = document.createElement('button');
        rm.className = 'cat-remove';
        rm.textContent = 'X';
        rm.title = 'Remove "' + cat + '"';
        rm.onclick = function() { removePricingCategory(cat); };
        label.appendChild(rm);
        tr.appendChild(label);
        for (let i = 0; i < 22; i++) {
            const td = document.createElement('td');
            const inp = document.createElement('input');
            inp.type = 'number';
            inp.min = 0; inp.max = 100; inp.step = 0.1;
            inp.value = (MARGIN_TABLE[cat][i] * 100).toFixed(1);
            inp.dataset.cat = cat;
            inp.dataset.tier = i;
            inp.addEventListener('input', onMarginInput);
            td.appendChild(inp);
            tr.appendChild(td);
        }
        tbl.appendChild(tr);
    }
}

function onMarginInput(e) {
    const cat = e.target.dataset.cat;
    const tier = Number(e.target.dataset.tier);
    const pct = Number(e.target.value);
    if (!Number.isFinite(pct)) return;
    MARGIN_TABLE[cat][tier] = Math.max(0, Math.min(100, pct)) / 100;
    e.target.classList.add('changed');
    renderPricing(parseFloat($('cost-ex').value) || 0);
    scheduleMarginSave();
}

let saveTimer = null;
function scheduleMarginSave() {
    clearTimeout(saveTimer);
    setMsg($('margin-msg'), 'Saving...');
    saveTimer = setTimeout(async function() {
        try {
            const res = await fetch('/Leader-Halo/api/margins', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(MARGIN_TABLE),
            });
            const data = await res.json();
            if (data.status === 'saved') {
                document.querySelectorAll('#margin-table input.changed')
                    .forEach(function(el) { el.classList.remove('changed'); });
                setMsg($('margin-msg'), 'Saved', 'success');
                setTimeout(function() { setMsg($('margin-msg'), ''); }, 1500);
            } else {
                setMsg($('margin-msg'), data.message || 'Save failed.', 'error');
            }
        } catch (err) {
            setMsg($('margin-msg'), 'Save failed: ' + err.message, 'error');
        }
    }, 600);
}

function setMsg(el, text, type) {
    el.textContent = text || '';
    el.className = 'msg' + (type ? ' ' + type : '');
}

$('reset-margins').onclick = function() {
    if (!confirm('Reset all margins to the built-in defaults? This overwrites your saved values.')) return;
    Object.assign(MARGIN_TABLE, defaultMarginTable());
    refreshCategories();
    renderMarginTable();
    setEditable(true);
    renderPricing(parseFloat($('cost-ex').value) || 0);
    scheduleMarginSave();
};

function defaultMarginTable() {
    const lin = function(D, B) { const v=[D]; for(var i=1;i<21;i++) v.push(D-(D-B)*(i/21)); v.push(B); return v; };
    function cb(){var B=0.28,D=0.79,v=[0.79,0.65,0.53,0.5,0.45,0.4];[0.8,0.82,0.85,0.89,0.93,0.95,0.96,0.98,0.99,1.0].forEach(function(k){v.push(D-(D-B)*k);});while(v.length<22)v.push(B);return v;}
    function cp(){var B=0.25,D=0.35,v=[D];[0.35,0.45,0.65,0.7,0.72,0.74,0.76,0.8,0.84,0.88,0.9,0.92,0.94,0.95,0.96,0.97,0.98,0.99,0.995,0.998].forEach(function(k){v.push(D-(D-B)*k);});v.push(B);return v;}
    function cm(){var B=0.25,D=0.35,v=[D];for(var i=1;i<=20;i++)v.push(D-(D-B)*(Math.log(1+1.5*i)/Math.log(1+1.5*21)));v.push(B);return v;}
    return {
        'Cables / Peripherals': cb(),
        'Computers': cp(),
        'Laptops': lin(0.35,0.25),
        'Components': cm(),
        'Printers': lin(0.38,0.28),
        'Printer Consumables': lin(0.38,0.28),
        'Software': lin(0.45,0.35),
        'Unifi Products': lin(0.22,0.12),
        'Data Recovery': lin(0.30,0.20),
        'Staff Purchases': Array(22).fill(0.10),
    };
}

$('add-category').onclick = async function() {
    var name = $('new-cat-name').value.trim();
    var margin = Number($('new-cat-margin').value) / 100;
    if (!name) { setMsg($('margin-msg'), 'Enter a category name.', 'error'); return; }
    try {
        const res = await fetch('/Leader-Halo/api/category', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: name, margin: margin }),
        });
        const data = await res.json();
        if (data.status === 'added') {
            MARGIN_TABLE[name] = Array(22).fill(margin);
            refreshCategories();
            populateCategories();
            renderMarginTable();
            setEditable(true);
            $('new-cat-name').value = '';
            setMsg($('margin-msg'), 'Added "' + name + '".', 'success');
        } else {
            setMsg($('margin-msg'), data.message || 'Could not add category.', 'error');
        }
    } catch (e) {
        setMsg($('margin-msg'), 'Error: ' + e.message, 'error');
    }
};

async function removePricingCategory(name) {
    if (!confirm('Remove pricing category "' + name + '"?')) return;
    try {
        const res = await fetch('/Leader-Halo/api/category?name=' + encodeURIComponent(name), { method: 'DELETE' });
        const data = await res.json();
        if (data.status === 'removed') {
            delete MARGIN_TABLE[name];
            refreshCategories();
            populateCategories();
            renderMarginTable();
            setEditable(true);
            setMsg($('margin-msg'), 'Removed "' + name + '".', 'success');
        }
    } catch (e) {
        setMsg($('margin-msg'), 'Error: ' + e.message, 'error');
    }
}

// ─── Edit toggle (password-gated) ──────────────────────────────────────────
let editUnlocked = false;

$('edit-toggle').onclick = async function() {
    if (editUnlocked) {
        editUnlocked = false;
        $('edit-toggle').textContent = 'Edit';
        $('edit-toggle').classList.remove('unlocked');
        setEditable(false);
        return;
    }
    var pw = prompt('Enter edit password:');
    if (!pw) return;
    try {
        const res = await fetch('/Leader-Halo/api/auth', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: pw }),
        });
        const data = await res.json();
        if (data.ok) {
            editUnlocked = true;
            $('edit-toggle').textContent = 'Lock';
            $('edit-toggle').classList.add('unlocked');
            setEditable(true);
            setMsg($('margin-msg'), '', '');
        } else {
            setMsg($('margin-msg'), 'Incorrect password.', 'error');
        }
    } catch (e) {
        setMsg($('margin-msg'), 'Error: ' + e.message, 'error');
    }
};

function setEditable(on) {
    document.querySelectorAll('#margin-table input').forEach(function(el) { el.disabled = !on; });
    document.querySelectorAll('.cat-remove').forEach(function(el) { el.disabled = !on; });
    $('add-cat-row').style.display = on ? '' : 'none';
    $('reset-row').style.display = on ? '' : 'none';
}

// ─── Init ──────────────────────────────────────────────────────────────────
async function init() {
    try {
        const res = await fetch('/Leader-Halo/api/margins');
        const saved = await res.json();
        if (saved && typeof saved === 'object') {
            for (const k of Object.keys(MARGIN_TABLE)) delete MARGIN_TABLE[k];
            for (const [k, v] of Object.entries(saved)) {
                if (Array.isArray(v) && v.length === 22) MARGIN_TABLE[k] = v;
            }
            refreshCategories();
        }
    } catch (e) { console.warn('Could not load margins:', e.message); }

    populateCategories();
    renderPricing(0);
    renderMarginTable();
    setEditable(false);
}

init();
