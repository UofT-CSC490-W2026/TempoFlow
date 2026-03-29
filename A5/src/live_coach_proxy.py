"""Transparent WebSocket proxy for Gemini Multimodal Live API.

The browser connects to A5; A5 opens the upstream connection to Google with
``GEMINI_API_KEY`` / ``GOOGLE_API_KEY`` so the key never reaches the client.
"""

from __future__ import annotations

import asyncio
import logging
import os
import ssl
from urllib.parse import quote

import certifi
from fastapi import APIRouter, WebSocket, WebSocketDisconnect

router = APIRouter()
log = logging.getLogger("uvicorn.error")

_GEMINI_WS = (
    "wss://generativelanguage.googleapis.com/ws/"
    "google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent"
)


def _get_upstream_url() -> str | None:
    api_key = os.environ.get("GEMINI_API_KEY") or os.environ.get("GOOGLE_API_KEY")
    if not api_key:
        return None
    return f"{_GEMINI_WS}?key={quote(api_key, safe='')}"


@router.websocket("/api/live-coach/ws")
async def live_coach_proxy(websocket: WebSocket) -> None:
    url = _get_upstream_url()
    if not url:
        log.error("[live-coach] GEMINI_API_KEY / GOOGLE_API_KEY not set")
        await websocket.close(code=1011, reason="GEMINI_API_KEY not configured on server")
        return

    await websocket.accept()
    log.info("[live-coach] Client connected, opening upstream to Gemini")

    try:
        import websockets  # type: ignore[import-untyped]
        from websockets.exceptions import ConnectionClosed
    except ImportError:
        log.error("[live-coach] 'websockets' package not installed")
        await websocket.close(code=1011, reason="Server missing websockets package")
        return

    ssl_ctx = ssl.create_default_context(cafile=certifi.where())

    upstream = None
    try:
        upstream = await asyncio.wait_for(
            websockets.connect(url, ssl=ssl_ctx, max_size=None, ping_interval=20, ping_timeout=20),
            timeout=15,
        )
        log.info("[live-coach] Upstream Gemini connection established")
    except asyncio.TimeoutError:
        log.error("[live-coach] Timed out connecting to Gemini")
        await websocket.close(code=1011, reason="Timed out connecting to Gemini")
        return
    except Exception as exc:
        log.error("[live-coach] Upstream connect failed: %s", exc)
        try:
            reason = str(exc)[:120]
            await websocket.close(code=1011, reason=reason)
        except Exception:
            pass
        return

    close_reason = ""

    async def client_to_upstream() -> None:
        nonlocal close_reason
        try:
            while True:
                msg = await websocket.receive()
                if msg.get("type") == "websocket.disconnect":
                    close_reason = close_reason or "client disconnected"
                    return
                text = msg.get("text")
                if text is not None:
                    await upstream.send(text)
                else:
                    bdata = msg.get("bytes")
                    if bdata is not None:
                        await upstream.send(bdata)
        except WebSocketDisconnect:
            close_reason = close_reason or "client disconnected"
        except Exception as exc:
            close_reason = close_reason or f"client→upstream: {exc}"
            log.warning("[live-coach] client→upstream error: %s", exc)

    async def upstream_to_client() -> None:
        nonlocal close_reason
        try:
            while True:
                data = await upstream.recv()
                if isinstance(data, (bytes, bytearray)):
                    await websocket.send_text(data.decode("utf-8", errors="replace"))
                else:
                    await websocket.send_text(data)
        except ConnectionClosed as exc:
            close_reason = close_reason or f"upstream closed: {exc.code} {exc.reason}"
            log.info("[live-coach] Upstream closed: code=%s reason=%s", exc.code, exc.reason)
        except Exception as exc:
            close_reason = close_reason or f"upstream→client: {exc}"
            log.warning("[live-coach] upstream→client error: %s", exc)

    t1 = asyncio.create_task(client_to_upstream())
    t2 = asyncio.create_task(upstream_to_client())

    try:
        _, pending = await asyncio.wait({t1, t2}, return_when=asyncio.FIRST_COMPLETED)
        for p in pending:
            p.cancel()
            try:
                await p
            except asyncio.CancelledError:
                pass
    finally:
        log.info("[live-coach] Session ended: %s", close_reason or "clean")
        try:
            await upstream.close()
        except Exception:
            pass
        try:
            await websocket.close()
        except Exception:
            pass
