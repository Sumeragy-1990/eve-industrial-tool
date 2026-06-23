"""Invention Campaigns API – CRUD for invention campaigns and results."""

import logging
from datetime import datetime, timezone
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, delete, and_
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_session
from app.models.character import Character
from app.models.industry_job import IndustryJob
from app.models.invention_campaign import InventionCampaign
from app.models.invention_campaign_result import InventionCampaignResult
from app.models.bpc_cost import UserBPCCost
from app.routers.auth import require_auth, require_account, assert_owns_character
from app.services.industry_job_sync import sync_character_industry_jobs

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/invention-campaigns", tags=["invention-campaigns"])


# ── Request Models ──────────────────────────────────────────────────

class CampaignCreateRequest(BaseModel):
    name: str
    t1_blueprint_type_id: int
    t1_blueprint_name: Optional[str] = None
    t2_product_type_id: int
    t2_product_name: Optional[str] = None
    character_id: int
    decryptor_type_id: Optional[int] = None
    decryptor_name: Optional[str] = None
    cost_index: float = 0.01
    install_fee_per_job: float = 0.0
    material_cost_per_job: float = 0.0
    decryptor_cost_per_job: float = 0.0
    total_cost_per_job: float = 0.0
    probability: float = 0.0
    expected_cost_per_success: float = 0.0
    runs_per_success: int = 1
    cost_per_t2_run: float = 0.0
    target_runs: int = 1


class CampaignUpdateRequest(BaseModel):
    name: Optional[str] = None
    status: Optional[str] = None  # active | paused | completed | archived
    cost_index: Optional[float] = None
    install_fee_per_job: Optional[float] = None
    material_cost_per_job: Optional[float] = None
    decryptor_cost_per_job: Optional[float] = None
    total_cost_per_job: Optional[float] = None
    probability: Optional[float] = None
    expected_cost_per_success: Optional[float] = None
    runs_per_success: Optional[int] = None
    cost_per_t2_run: Optional[float] = None
    target_runs: Optional[int] = None
    decryptor_type_id: Optional[int] = None
    decryptor_name: Optional[str] = None


class ResultCreateRequest(BaseModel):
    character_id: int
    t1_blueprint_type_id: int
    t2_product_type_id: int
    t2_product_name: Optional[str] = None
    decryptor_type_id: Optional[int] = None
    decryptor_name: Optional[str] = None
    attempts: int = 1
    successes: int = 0
    probability: Optional[float] = None
    runs: int = 1
    me: int = 0
    te: int = 0
    cost_per_job: float = 0.0
    total_cost: float = 0.0
    status: str = "running"  # running | completed | failed


# ── Helper ─────────────────────────────────────────────────────────

def _campaign_to_dict(c: InventionCampaign) -> dict:
    return {
        "id": c.id,
        "user_id": c.user_id,
        "name": c.name,
        "status": c.status,
        "t1_blueprint_type_id": c.t1_blueprint_type_id,
        "t1_blueprint_name": c.t1_blueprint_name,
        "t2_product_type_id": c.t2_product_type_id,
        "t2_product_name": c.t2_product_name,
        "activity_id": c.activity_id,
        "decryptor_type_id": c.decryptor_type_id,
        "decryptor_name": c.decryptor_name,
        "character_id": c.character_id,
        "cost_index": c.cost_index,
        "install_fee_per_job": c.install_fee_per_job,
        "material_cost_per_job": c.material_cost_per_job,
        "decryptor_cost_per_job": c.decryptor_cost_per_job,
        "total_cost_per_job": c.total_cost_per_job,
        "probability": c.probability,
        "expected_cost_per_success": c.expected_cost_per_success,
        "runs_per_success": c.runs_per_success,
        "cost_per_t2_run": c.cost_per_t2_run,
        "target_runs": c.target_runs,
        "last_synced": c.last_synced.isoformat() if c.last_synced else None,
        "created_at": c.created_at.isoformat() if c.created_at else None,
        "updated_at": c.updated_at.isoformat() if c.updated_at else None,
    }


def _result_to_dict(r: InventionCampaignResult) -> dict:
    return {
        "id": r.id,
        "campaign_id": r.campaign_id,
        "industry_job_id": r.industry_job_id,
        "character_id": r.character_id,
        "t1_blueprint_type_id": r.t1_blueprint_type_id,
        "t2_product_type_id": r.t2_product_type_id,
        "t2_product_name": r.t2_product_name,
        "decryptor_type_id": r.decryptor_type_id,
        "decryptor_name": r.decryptor_name,
        "attempts": r.attempts,
        "successes": r.successes,
        "probability": r.probability,
        "runs": r.runs,
        "me": r.me,
        "te": r.te,
        "cost_per_job": r.cost_per_job,
        "total_cost": r.total_cost,
        "bpc_cost_id": r.bpc_cost_id,
        "status": r.status,
        "created_at": r.created_at.isoformat() if r.created_at else None,
    }


# ── Campaign Endpoints ─────────────────────────────────────────────

@router.post("/")
async def create_campaign(
    body: CampaignCreateRequest,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Create a new invention campaign."""
    campaign = InventionCampaign(
        user_id=user_id,
        name=body.name,
        status="active",
        t1_blueprint_type_id=body.t1_blueprint_type_id,
        t1_blueprint_name=body.t1_blueprint_name,
        t2_product_type_id=body.t2_product_type_id,
        t2_product_name=body.t2_product_name,
        activity_id=3,
        decryptor_type_id=body.decryptor_type_id,
        decryptor_name=body.decryptor_name,
        character_id=body.character_id,
        cost_index=body.cost_index,
        install_fee_per_job=body.install_fee_per_job,
        material_cost_per_job=body.material_cost_per_job,
        decryptor_cost_per_job=body.decryptor_cost_per_job,
        total_cost_per_job=body.total_cost_per_job,
        probability=body.probability,
        expected_cost_per_success=body.expected_cost_per_success,
        runs_per_success=body.runs_per_success,
        cost_per_t2_run=body.cost_per_t2_run,
        target_runs=body.target_runs,
    )
    db.add(campaign)
    await db.flush()
    await db.commit()
    return _campaign_to_dict(campaign)


@router.get("/")
async def list_campaigns(
    status: Optional[str] = Query(None, description="Filter by status"),
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """List all invention campaigns for the current user."""
    stmt = select(InventionCampaign).where(InventionCampaign.user_id == user_id)
    if status:
        stmt = stmt.where(InventionCampaign.status == status)
    stmt = stmt.order_by(InventionCampaign.created_at.desc())

    result = await db.execute(stmt)
    campaigns = result.scalars().all()
    return {"campaigns": [_campaign_to_dict(c) for c in campaigns]}


@router.get("/{campaign_id}")
async def get_campaign(
    campaign_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Get a single invention campaign with its results."""
    stmt = select(InventionCampaign).where(
        and_(
            InventionCampaign.id == campaign_id,
            InventionCampaign.user_id == user_id,
        )
    )
    result = await db.execute(stmt)
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    # Fetch results
    rstmt = select(InventionCampaignResult).where(
        InventionCampaignResult.campaign_id == campaign_id
    ).order_by(InventionCampaignResult.created_at.desc())
    rresult = await db.execute(rstmt)
    results = rresult.scalars().all()

    data = _campaign_to_dict(campaign)
    data["results"] = [_result_to_dict(r) for r in results]

    # Summary stats
    total_attempts = sum(r.attempts for r in results)
    total_successes = sum(r.successes for r in results)
    total_cost = sum(r.total_cost for r in results)
    data["summary"] = {
        "total_attempts": total_attempts,
        "total_successes": total_successes,
        "total_cost": round(total_cost, 2),
        "overall_probability": round(total_successes / max(total_attempts, 1), 4),
        "result_count": len(results),
    }

    return data


@router.put("/{campaign_id}")
async def update_campaign(
    campaign_id: int,
    body: CampaignUpdateRequest,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Update an invention campaign (status, costs, target, etc.)."""
    stmt = select(InventionCampaign).where(
        and_(
            InventionCampaign.id == campaign_id,
            InventionCampaign.user_id == user_id,
        )
    )
    result = await db.execute(stmt)
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    update_data = body.model_dump(exclude_none=True)
    for key, value in update_data.items():
        if hasattr(campaign, key):
            setattr(campaign, key, value)

    campaign.updated_at = datetime.now(timezone.utc)
    await db.flush()
    await db.commit()
    return _campaign_to_dict(campaign)


@router.delete("/{campaign_id}")
async def delete_campaign(
    campaign_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Delete an invention campaign and its results."""
    stmt = select(InventionCampaign).where(
        and_(
            InventionCampaign.id == campaign_id,
            InventionCampaign.user_id == user_id,
        )
    )
    result = await db.execute(stmt)
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    # Delete results first (CASCADE should handle this, but be explicit)
    del_stmt = delete(InventionCampaignResult).where(
        InventionCampaignResult.campaign_id == campaign_id
    )
    await db.execute(del_stmt)

    await db.delete(campaign)
    await db.flush()
    await db.commit()
    return {"status": "deleted", "campaign_id": campaign_id}


# ── Result Endpoints ───────────────────────────────────────────────

@router.post("/{campaign_id}/results")
async def create_result(
    campaign_id: int,
    body: ResultCreateRequest,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Add a result entry to an invention campaign."""
    # Verify campaign exists and belongs to user
    stmt = select(InventionCampaign).where(
        and_(
            InventionCampaign.id == campaign_id,
            InventionCampaign.user_id == user_id,
        )
    )
    result = await db.execute(stmt)
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    entry = InventionCampaignResult(
        campaign_id=campaign_id,
        character_id=body.character_id,
        t1_blueprint_type_id=body.t1_blueprint_type_id,
        t2_product_type_id=body.t2_product_type_id,
        t2_product_name=body.t2_product_name,
        decryptor_type_id=body.decryptor_type_id,
        decryptor_name=body.decryptor_name,
        attempts=body.attempts,
        successes=body.successes,
        probability=body.probability,
        runs=body.runs,
        me=body.me,
        te=body.te,
        cost_per_job=body.cost_per_job,
        total_cost=body.total_cost,
        status=body.status,
    )
    db.add(entry)
    await db.flush()

    # Update campaign last_synced
    campaign.last_synced = datetime.now(timezone.utc)
    await db.commit()

    return _result_to_dict(entry)


@router.get("/{campaign_id}/results")
async def list_results(
    campaign_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """List all results for an invention campaign."""
    # Verify campaign exists and belongs to user
    stmt = select(InventionCampaign).where(
        and_(
            InventionCampaign.id == campaign_id,
            InventionCampaign.user_id == user_id,
        )
    )
    result = await db.execute(stmt)
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    rstmt = select(InventionCampaignResult).where(
        InventionCampaignResult.campaign_id == campaign_id
    ).order_by(InventionCampaignResult.created_at.desc())
    rresult = await db.execute(rstmt)
    results = rresult.scalars().all()

    return {"results": [_result_to_dict(r) for r in results]}


@router.delete("/{campaign_id}/results/{result_id}")
async def delete_result(
    campaign_id: int,
    result_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Delete a specific result entry."""
    # Verify campaign exists and belongs to user
    stmt = select(InventionCampaign).where(
        and_(
            InventionCampaign.id == campaign_id,
            InventionCampaign.user_id == user_id,
        )
    )
    result = await db.execute(stmt)
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    rstmt = select(InventionCampaignResult).where(
        and_(
            InventionCampaignResult.id == result_id,
            InventionCampaignResult.campaign_id == campaign_id,
        )
    )
    rresult = await db.execute(rstmt)
    entry = rresult.scalar_one_or_none()
    if not entry:
        raise HTTPException(status_code=404, detail="Result not found")

    await db.delete(entry)
    await db.flush()
    await db.commit()
    return {"status": "deleted", "result_id": result_id}


# ── ESI Sync (Phase C5) ───────────────────────────────────────────

@router.post("/sync/{campaign_id}")
async def sync_campaign_invention_jobs(
    campaign_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Sync industry jobs from ESI and match invention jobs to a campaign.

    Reuses the existing industry_job_sync service. After syncing, matches
    invention jobs (activity_id=3) belonging to the campaign's character
    and matching the T1 blueprint type_id, then creates result entries.
    """
    # Verify campaign
    stmt = select(InventionCampaign).where(
        and_(
            InventionCampaign.id == campaign_id,
            InventionCampaign.user_id == user_id,
        )
    )
    result = await db.execute(stmt)
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    # Sync industry jobs for the campaign's character
    char_stmt = select(Character).where(Character.character_id == campaign.character_id)
    char_result = await db.execute(char_stmt)
    character = char_result.scalar_one_or_none()
    if not character:
        raise HTTPException(status_code=404, detail="Campaign character not found in local DB")

    sync_result = await sync_character_industry_jobs(db, character)

    # Find invention jobs matching this campaign
    job_stmt = select(IndustryJob).where(
        and_(
            IndustryJob.character_id == campaign.character_id,
            IndustryJob.blueprint_type_id == campaign.t1_blueprint_type_id,
            IndustryJob.activity_id == 3,  # Invention
        )
    )
    job_result = await db.execute(job_stmt)
    jobs = job_result.scalars().all()

    matched = 0
    new_results = []
    for job in jobs:
        # Check if we already have a result for this job
        existing_stmt = select(InventionCampaignResult).where(
            InventionCampaignResult.industry_job_id == job.job_id
        )
        existing_result = await db.execute(existing_stmt)
        if existing_result.scalar_one_or_none():
            continue

        # Create result entry
        attempts = job.runs or 1
        successes = job.successful_runs or 0
        probability = job.probability
        runs_per_success = job.successful_runs or 0

        entry = InventionCampaignResult(
            campaign_id=campaign_id,
            industry_job_id=job.job_id,
            character_id=job.character_id,
            t1_blueprint_type_id=campaign.t1_blueprint_type_id,
            t2_product_type_id=campaign.t2_product_type_id,
            t2_product_name=campaign.t2_product_name,
            decryptor_type_id=campaign.decryptor_type_id,
            decryptor_name=campaign.decryptor_name,
            attempts=attempts,
            successes=successes,
            probability=probability,
            runs=runs_per_success,
            me=0,
            te=0,
            cost_per_job=campaign.total_cost_per_job,
            total_cost=campaign.total_cost_per_job * attempts,
            status="completed" if successes > 0 and probability else ("completed" if job.status == "ready" else job.status),
        )
        db.add(entry)
        new_results.append(entry)
        matched += 1

    if matched > 0:
        campaign.last_synced = datetime.now(timezone.utc)
        await db.flush()

    return {
        "campaign_id": campaign_id,
        "sync_result": sync_result,
        "jobs_found": len(jobs),
        "new_results_created": matched,
    }


# ── Save to BPC Stock (Phase C6) ──────────────────────────────────

@router.post("/{campaign_id}/save-to-stock")
async def save_campaign_to_stock(
    campaign_id: int,
    user_id: int = Depends(require_account),
    db: AsyncSession = Depends(get_session),
):
    """Save all completed campaign results as BPC Stock entries (UserBPCCost)."""
    # Verify campaign
    stmt = select(InventionCampaign).where(
        and_(
            InventionCampaign.id == campaign_id,
            InventionCampaign.user_id == user_id,
        )
    )
    result = await db.execute(stmt)
    campaign = result.scalar_one_or_none()
    if not campaign:
        raise HTTPException(status_code=404, detail="Campaign not found")

    # Get all completed results that haven't been saved to stock yet
    rstmt = select(InventionCampaignResult).where(
        and_(
            InventionCampaignResult.campaign_id == campaign_id,
            InventionCampaignResult.status == "completed",
            InventionCampaignResult.bpc_cost_id.is_(None),
        )
    )
    rresult = await db.execute(rstmt)
    results = rresult.scalars().all()

    saved = 0
    for r in results:
        total_cost = r.total_cost
        # If this is a successful invention batch, use the campaign cost per T2 run
        if r.successes > 0 and r.runs > 0:
            cost_per_run = total_cost / (r.successes * r.runs)
        else:
            cost_per_run = total_cost / max(r.attempts * r.runs, 1)

        bpc_entry = UserBPCCost(
            character_id=user_id,
            bp_type_id=campaign.t1_blueprint_type_id,
            product_type_id=campaign.t2_product_type_id,
            product_name=campaign.t2_product_name,
            cost_source="invention",
            source_bp_type_id=campaign.t1_blueprint_type_id,
            total_cost=round(total_cost, 2),
            runs=r.runs * max(r.successes, 1),
            cost_per_run=round(cost_per_run, 2),
            me=r.me,
            te=r.te,
            decryptor_type_id=campaign.decryptor_type_id,
            decryptor_name=campaign.decryptor_name,
            invention_attempts=r.attempts,
            invention_probability=r.probability,
        )
        db.add(bpc_entry)
        await db.flush()

        # Link result to the BPC stock entry
        r.bpc_cost_id = bpc_entry.id
        saved += 1

    if saved > 0:
        campaign.last_synced = datetime.now(timezone.utc)
        await db.flush()

    return {
        "campaign_id": campaign_id,
        "results_saved": saved,
    }
