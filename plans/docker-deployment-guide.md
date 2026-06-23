# Docker Deployment Guide

## Critical: `docker compose restart` vs `--force-recreate`

**🚨 WARNING:** `docker compose restart backend` restarts the **existing container** but does NOT recreate it from a newly built image. If the container was created from an old image, `restart` will still run the OLD code.

### Correct deployment sequence after code changes:

```bash
# Step 1: Build the image (--no-cache forces COPY app/ ./app/ to re-run)
docker compose build --no-cache backend

# Step 2: Recreate the container from the new image
docker compose up -d --force-recreate backend
```

### Why `--no-cache` is needed

The Dockerfile has `COPY app/ ./app/` on line 33. Docker caches this layer if the build context hash hasn't changed. However, file modifications inside `app/` are sometimes not detected by Docker's layer cache. Using `--no-cache` forces ALL layers to rebuild.

### Verify the fix

```bash
# Check that the new code is actually inside the container
docker exec eve-backend sh -c 'grep "function onInvSearchInput" /app/app/templates/static/js/bp-browser.js | wc -l'
# Should output: 1

# Check that the image is newer than the container
docker images eve-industrial-tool-backend --format "table {{.Repository}}:{{.Tag}}\t{{.ID}}\t{{.CreatedAt}}"
docker inspect eve-backend --format '{{.Image}}'
```

### Quick one-liner (all steps)

```bash
cd /pfad/zum/projekt
docker compose build --no-cache backend && docker compose up -d --force-recreate backend
```

---

## Container Structure

| Component | Container | Image | Port |
|-----------|-----------|-------|------|
| Backend (FastAPI) | `eve-backend` | `eve-industrial-tool-backend` | 8082 → 8080 |
| Database | `eve-db` | `postgres:15-alpine` | 5432 |

## Volumes

| Volume | Mount | Purpose |
|--------|-------|---------|
| `eve-sde-cache` | `/app/sde_cache` | SDE import cache (persists across rebuilds) |
| `eve-db-data` | `/var/lib/postgresql/data` | Database data |

## Useful commands

```bash
# View logs
docker compose logs --tail 50 backend

# Check container status
docker compose ps -a

# Restart all services
docker compose down && docker compose up -d

# Full rebuild + restart
docker compose build --no-cache backend && docker compose up -d --force-recreate backend
```
