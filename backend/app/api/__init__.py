"""Aggregate API router mounted under ``/api`` by the app factory."""

from fastapi import APIRouter

from app.api.health import router as health_router

api_router = APIRouter()
api_router.include_router(health_router)
