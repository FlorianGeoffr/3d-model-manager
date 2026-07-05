"""Server-Sent Events endpoint (SPEC "API surface"; Global Constraints: SSE
at ``GET /api/events``, Redis pub/sub channel ``tdmm:events``).
"""

from __future__ import annotations

from collections.abc import AsyncIterator

import anyio
import redis.asyncio as aioredis
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse

from app.config import Settings, get_settings
from app.services.events import CHANNEL

router = APIRouter(tags=["events"])


async def _event_stream(redis_url: str, heartbeat_interval: float) -> AsyncIterator[bytes]:
    client = aioredis.Redis.from_url(redis_url)
    pubsub = client.pubsub()
    await pubsub.subscribe(CHANNEL)
    try:
        while True:
            message = await pubsub.get_message(
                ignore_subscribe_messages=True, timeout=heartbeat_interval
            )
            if message is None:
                yield b": ping\n\n"
                continue
            data = message["data"]
            if isinstance(data, bytes):
                data = data.decode()
            yield f"data: {data}\n\n".encode()
    finally:
        # Client disconnect closes this generator from inside an already-
        # cancelled scope (Starlette cancels the request task, which throws
        # into wherever the generator was suspended -- here, the
        # `get_message` await above). Without shielding, the FIRST await
        # below raises `CancelledError` immediately, skipping
        # `pubsub.aclose()`/`client.aclose()` entirely and leaking the Redis
        # connection. Shield just these cleanup awaits so they run to
        # completion regardless of the outer cancellation.
        with anyio.CancelScope(shield=True):
            await pubsub.unsubscribe(CHANNEL)
            await pubsub.aclose()
            await client.aclose()


@router.get("/events")
async def sse_events(settings: Settings = Depends(get_settings)) -> StreamingResponse:
    return StreamingResponse(
        _event_stream(settings.redis_url, settings.sse_heartbeat_interval_s),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
