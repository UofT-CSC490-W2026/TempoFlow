"""Evaluation module — combined router for /review and /dashboard."""
from fastapi import APIRouter

from .dashboard import router as dashboard_router
from .review_ui import router as review_router

router = APIRouter()
router.include_router(review_router)
router.include_router(dashboard_router)
