# Leader → Halo Product Sync (webapp)

A small Node/Express app that looks up products in the Leader Systems catalogue,
applies the tiered pricing engine, and creates them in HaloPSA. Replaces the
original Teams/Excel/Power-Automate flow and the n8n attempt with a simple,
debuggable service.

```
webapp/
├── src/
│   ├── server.js     # Express app: /api/status /api/lookup /api/confirm /api/refresh
│   ├── db.js         # SQLite (sql.js / WASM) catalogue store
│   ├── pricing.js    # tiered margin engine (ported + verified from the Excel workbook)
│   ├── leader.js     # download + stream-parse the Leader CSV feed
│   └── halo.js       # OAuth2 token + create Halo Item
├── public/           # the UI (served at /), embeddable in Halo via iframe
├── .env.example
└── package.json
```

## Run locally

1. **Install Node 20+** (if not present).
2. `npm install`
3. Copy `.env.example` → `.env` and fill in the values.
4. `npm run dev` (auto-restarts on file changes) or `npm start`.

The app listens on **port 9100** (configurable via `PORT`). On first start with
an empty database it downloads the ~20MB Leader catalogue in the background
(~45s) and indexes all ~19,800 products. Lookups then return in <50ms.

Open `http://localhost:9100` for the UI.

## How it works

- **Refresh** (every 6h, or via `POST /api/refresh`): downloads the Leader CSV
  feed, stream-parses it, and bulk-replaces the SQLite catalogue.
- **Lookup** (`POST /api/lookup` `{sku}`): one SQL query matches on stock code,
  manufacturer SKU, or barcode (case-insensitive), runs the pricing engine, and
  returns the product + computed prices.
- **Confirm** (`POST /api/confirm` `{product, category}`): builds the Halo Item
  payload and `POST /api/Item`s it. Returns the new item ID + Halo link.

The pricing engine (10-category × 22-cost-tier margin table) is the same one
verified against the source workbook. Spot-check with:
```js
import { priceProduct } from './src/pricing.js';
console.log(priceProduct(269, 'Unifi Products'));  // → retail 366
```

## Configuration (.env)

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `9100` | **Tell whoever configures HAProxy to forward to this port.** |
| `LEADER_CUSTOMER_CODE` | — | Your Leader data-feed token |
| `LEADER_REFRESH_HOURS` | `6` | Catalogue refresh interval |
| `HALO_BASE_URL` | `https://halo.elliotts.tech` | |
| `HALO_CLIENT_ID` | — | OAuth client id |
| `HALO_CLIENT_SECRET` | — | OAuth client secret |
| `DB_PATH` | `./data/catalogue.db` | SQLite file location |

## Deploy as a service

The app runs as a plain Node process — run it under a process manager so it
survives reboots. On the WebApps server (Linux), systemd or pm2 both work:

**systemd** (`/etc/systemd/system/leader-halo-sync.service`):
```ini
[Unit]
Description=Leader → Halo Product Sync
After=network.target

[Service]
Type=simple
User=root
WorkingDirectory=/opt/leader-halo-sync
EnvironmentFile=/opt/leader-halo-sync/.env
ExecStart=/usr/bin/node src/server.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```
Then: `systemctl enable --now leader-halo-sync`.

**pm2**: `pm2 start src/server.js --name leader-halo-sync && pm2 save && pm2 startup`.

Docker is also fine if you prefer consistency with other apps — a basic
`node:20-slim` image copying the `webapp/` dir and running `node src/server.js`
with the `.env` works. No native modules to compile (sql.js is WASM).

Either way, expose **port 9100** through your HAProxy/frontend as whatever
hostname/path you want (e.g. `leader-sync.elliotts.tech` → `webapps:9100`).

## ⚠️ Halo write permission

The Halo OAuth client needs the **items:edit** (write) permission area enabled
in Halo Config → Integrations → API Applications. Currently the client can
**read** items (200) but not **create** them (403). Lookups + pricing work
fully; the final create-to-Halo step returns 403 until that scope is granted.

## Embed in Halo

Point a Halo custom tile / iframe at the app's URL (e.g.
`https://leader-sync.elliotts.tech`). The UI is self-contained at ~800px wide
and handles the full search → confirm → result flow.
```
