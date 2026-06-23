"""EVE Industrial Tool – FastAPI Application Entry Point."""

import asyncio
import logging
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, RedirectResponse
from starlette.middleware.sessions import SessionMiddleware

from app.config import settings
from app.database import init_db
from app.routers import auth, assets, sde, corp, restock, industry, build_calculator, cost_indices, market, blueprints, invention, character_restock, selling, admin, location_aliases, corp_warehouses, sync_all, user_prices, bpc_costs, bpc_stock_thresholds
from app.services.sync_orchestrator import start_auto_sync

# ── Logging ────────────────────────────────────────────────────

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
logger = logging.getLogger(__name__)

# ── Lifespan ───────────────────────────────────────────────────


async def _startup_price_refresh():
    """Run one market price refresh immediately after startup.

    The auto-sync loop sleeps for the full interval (4 h) before its first
    run, so after a fresh install or restart the price cache is empty for up
    to 4 hours. This coroutine fires once, right after DB init, to pre-fill
    the cache so blueprints show prices immediately.
    """
    # Small delay so the DB session factory is fully ready
    await asyncio.sleep(5)
    try:
        from app.database import async_session_factory
        from app.services.market_service import refresh_all_prices
        async with async_session_factory() as db:
            stats = await refresh_all_prices(db)
            logger.info(
                "Startup price refresh done: %d updated, %d errors",
                stats.get("updated", 0),
                stats.get("errors", 0),
            )
    except Exception as exc:
        logger.warning("Startup price refresh failed (non-fatal): %s", exc)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Initialize database on startup and start background tasks."""
    logger.info("Starting EVE Industrial Tool ...")
    await init_db()
    logger.info("Database initialized")
    # Start the auto-sync background loop
    start_auto_sync()
    logger.info("Auto-sync background task started")
    # Trigger an immediate price refresh in the background on startup so prices
    # are available right away instead of waiting up to 4 hours for the first
    # auto-sync interval to elapse.
    asyncio.create_task(_startup_price_refresh())
    logger.info("Startup price refresh scheduled")
    yield
    logger.info("Shutting down EVE Industrial Tool ...")


# ── App ────────────────────────────────────────────────────────

app = FastAPI(
    title=settings.app_name,
    version="1.0.0",
    lifespan=lifespan,
)

# Session middleware (required for EVE SSO OAuth flow)
app.add_middleware(SessionMiddleware, secret_key=settings.jwt_secret_key)

# Mount static files
app.mount("/static", StaticFiles(directory="app/templates/static"), name="static")

# Templates
templates = Jinja2Templates(directory="app/templates")


# ── Auto cache-buster ───────────────────────────────────────────
# Appends ?v=<file-mtime> to static asset URLs so browsers automatically fetch
# a fresh copy whenever a file changes on disk. This permanently ends the old
# "cache trap" (hand-bumped ?v= strings that, when forgotten, made the browser
# silently run stale JS/CSS). Use in templates: {{ static_url('js/app.js') }}.

_STATIC_DIR = Path("app/templates/static")


def static_url(path: str) -> str:
    """Return /static/<path>?v=<mtime>; falls back to no version if missing."""
    try:
        mtime = int((_STATIC_DIR / path).stat().st_mtime)
        return f"/static/{path}?v={mtime}"
    except OSError:
        return f"/static/{path}"


templates.env.globals["static_url"] = static_url

# Register routers
app.include_router(auth.router)
app.include_router(assets.router)
app.include_router(corp.router)
app.include_router(sde.router)
app.include_router(restock.router)
app.include_router(industry.router)
app.include_router(build_calculator.router)
app.include_router(cost_indices.router)
app.include_router(market.router)
app.include_router(blueprints.router)
app.include_router(invention.router)
app.include_router(character_restock.router)
app.include_router(selling.router)
app.include_router(admin.router)
app.include_router(location_aliases.router)
app.include_router(corp_warehouses.router)
app.include_router(sync_all.router)
app.include_router(user_prices.router)
app.include_router(bpc_costs.router)
app.include_router(bpc_stock_thresholds.router)


# ── Auth helper for page routes ─────────────────────────────────


def _get_session_char_id(request: Request) -> int | None:
    """Read character_id from session cookie (non-async, for page routes)."""
    return request.session.get("character_id")


# ── Login page (no auth required) ───────────────────────────────


@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    """Serve the login page. Redirects to blueprints if already authenticated."""
    char_id = _get_session_char_id(request)
    if char_id:
        return RedirectResponse(url="/blueprints", status_code=302)
    return templates.TemplateResponse(
        "login.html",
        {"request": request},
    )


# ── Root route (redirect to blueprints if authenticated) ────────


@app.get("/", response_class=HTMLResponse)
async def index(request: Request):
    """Root entry point — redirect to blueprint shopper if authenticated, else login."""
    char_id = _get_session_char_id(request)
    if not char_id:
        return RedirectResponse(url="/login", status_code=302)
    return templates.TemplateResponse(
        "index.html",
        {"request": request, "character_id": char_id},
    )


# ── Blueprint Shopper page (auth required) ──────────────────────


@app.get("/blueprints", response_class=HTMLResponse)
async def blueprints_page(request: Request):
    """Serve the standalone Blueprint Shopper page (auth required)."""
    char_id = _get_session_char_id(request)
    if not char_id:
        return RedirectResponse(url="/login", status_code=302)
    return templates.TemplateResponse(
        "blueprints.html",
        {"request": request, "character_id": char_id},
    )


# ── Health check ───────────────────────────────────────────────


@app.get("/health")
async def health():
    return {"status": "ok", "app": settings.app_name}