"""Projects API: CRUD endpoints and aggregation statistics."""

from __future__ import annotations

from fastapi import APIRouter, Depends, status
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import Settings, get_settings
from app.db import get_db
from app.schemas.projects import ProjectCreate, ProjectOut, ProjectUpdate
from app.services import projects as projects_service
from app.services import zip_export
from app.services.http_names import content_disposition_attachment

router = APIRouter(prefix="/projects", tags=["projects"])


@router.get("", response_model=list[ProjectOut])
async def list_projects(db: AsyncSession = Depends(get_db)) -> list[ProjectOut]:
    return await projects_service.list_projects(db)


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ProjectOut)
async def create_project(payload: ProjectCreate, db: AsyncSession = Depends(get_db)) -> ProjectOut:
    return await projects_service.create_project(
        db,
        name=payload.name,
        description=payload.description,
        color=payload.color,
        icon=payload.icon,
        parent_id=payload.parent_id,
    )


@router.get("/{project_id}", response_model=ProjectOut)
async def get_project(project_id: int, db: AsyncSession = Depends(get_db)) -> ProjectOut:
    return await projects_service.get_project(db, project_id)


@router.get("/{project_id}/zip")
async def download_project_zip(
    project_id: int,
    db: AsyncSession = Depends(get_db),
    settings: Settings = Depends(get_settings),
) -> StreamingResponse:
    """Stream a zip nesting every model in this project and its subprojects as
    `<project>/[<subproject>/.../]<model-slug>/...`.
    """
    project = await projects_service._get_project_or_404(db, project_id)
    _chunk, body = await zip_export.first_chunk(zip_export.iter_project_zip(db, settings, project))

    return StreamingResponse(
        body,
        media_type="application/zip",
        headers={"Content-Disposition": content_disposition_attachment(f"{project.name}.zip")},
    )


@router.patch("/{project_id}", response_model=ProjectOut)
async def update_project(
    project_id: int, payload: ProjectUpdate, db: AsyncSession = Depends(get_db)
) -> ProjectOut:
    return await projects_service.update_project(
        db, project_id, payload.model_dump(exclude_unset=True)
    )


@router.delete("/{project_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_project(project_id: int, db: AsyncSession = Depends(get_db)) -> None:
    await projects_service.delete_project(db, project_id)
