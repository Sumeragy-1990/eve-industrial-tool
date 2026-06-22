# EVE Industrial Tool

Self-hosted asset viewer for EVE Online, using CCP's ESI API directly.
Displays corporation hangar and character assets for multi-boxing setups.

## Architecture

```
┌──────────────┐    ESI/SDE    ┌──────────┐     ┌────────────┐
│  EVE Online  │◄─────────────►│ Backend  │────►│ PostgreSQL │
│    (CCP)     │               │ (FastAPI)│     │   (+ SDE)  │
└──────────────┘               └────┬─────┘     └────────────┘
                                    │
                                    ▼
                             ┌──────────────┐
                             │ Web UI (SPA) │
                             │ (Bootstrap 5)│
                             └──────────────┘
```

## Prerequisites

- Docker & Docker Compose installed
- An EVE SSO application registered at https://developers.eveonline.com
  - **Callback URL:** `http://192.168.178.24:8082/auth/callback` (adjust to your server)
  - **Required Scopes:**
    - `esi-assets.read_assets.v1`
    - `esi-assets.read_corporation_assets.v1`
    - `esi-corporations.read_divisions.v1`
    - `esi-characters.read_corporation_roles.v1`
    - `esi-characters.read_blueprints.v1`
    - `esi-corporations.read_blueprints.v1`
    - `esi-industry.read_character_jobs.v1`
    - `esi-industry.read_corporation_jobs.v1`

## Quick Start

### 1. Configure

```bash
cp .env.example .env
# Edit .env with your EVE SSO credentials
nano .env
```

### 2. Start

```bash
docker compose up -d
```

The web UI will be available at: **http://192.168.178.24:8082**

### 3. Add Characters

1. Click **"Add Character"** in the top navbar
2. Log in via EVE SSO (approve the required scopes)
3. You'll be redirected back to the tool
4. Click **"Sync Now"** to fetch assets

### 4. SDE Update (Item Database)

The first time you sync assets, item names are fetched from the built-in SDE.
To update after a CCP patch:

1. Click **"Update SDE"** in the top navbar
2. Confirm – this downloads ~200MB and imports it
3. Wait for completion (a few minutes)

## Features

- **Character Assets:** View all items for any authenticated character
- **Corporation Assets:** View corporation hangars (requires Director role)
- **Filters:** Search by name, category, location, hangar division
- **Auto-refresh:** Token refresh via EVE SSO refresh tokens
- **SDE Auto-Update:** One-click re-import after CCP patches
- **Multi-account:** Add multiple characters, switch between them

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Web UI |
| GET | `/auth/characters` | List registered characters |
| GET | `/auth/login` | EVE SSO login |
| GET | `/auth/callback` | EVE SSO callback |
| POST | `/api/assets/sync/{id}` | Trigger asset sync |
| GET | `/api/assets/` | Query assets (filtered, paginated) |
| GET | `/api/assets/locations` | Get distinct locations |
| GET | `/api/assets/divisions` | Get hangar divisions |
| GET | `/api/sde/status` | SDE import status |
| POST | `/api/sde/update` | Trigger SDE re-import |
| GET | `/health` | Health check |

## Volumes

- `eve-db-data` – PostgreSQL database (persistent)
- `eve-sde-cache` – Cached SDE downloads

## Development

```bash
# Run locally without Docker
cd backend
pip install -r requirements.txt
export DATABASE_URL="postgresql+asyncpg://eve:eve_password@localhost:5432/eve_industrial"
# ... other env vars
uvicorn app.main:app --reload --port 8082
```

## File Structure

```
eve-industrial-tool/
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app/
│       ├── main.py              # FastAPI entry point
│       ├── config.py            # Environment configuration
│       ├── database.py          # SQLAlchemy setup
│       ├── models/
│       │   ├── character.py     # Character model (OAuth tokens)
│       │   ├── asset.py         # Asset model (items)
│       │   └── sde_item.py      # SDE item definitions
│       ├── routers/
│       │   ├── auth.py          # EVE SSO OAuth flow
│       │   ├── assets.py        # Asset query & sync endpoints
│       │   └── sde.py           # SDE update endpoint
│       ├── services/
│       │   ├── esi_client.py    # ESI API client with auth
│       │   ├── asset_sync.py    # Asset sync logic
│       │   └── sde_importer.py  # SDE download & import
│       └── templates/
│           ├── index.html       # Main SPA page
│           └── static/
│               ├── css/style.css
│               └── js/app.js
├── docker-compose.yml
├── .env.example
└── README.md
```
