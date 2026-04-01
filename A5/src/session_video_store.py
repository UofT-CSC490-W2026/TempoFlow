import os
import threading
from typing import Dict, Tuple, Optional

# (session_id, side) -> local_filepath
_SESSION_VARS: Dict[Tuple[str, str], str] = {}
_SESSION_LOCK = threading.Lock()

def register_session_video(session_id: str, side: str, path: str) -> None:
    if not session_id or not side or not path:
        return
    with _SESSION_LOCK:
        _SESSION_VARS[(session_id, side)] = path

def get_session_video(session_id: str, side: str) -> Optional[str]:
    if not session_id or not side:
        return None
    with _SESSION_LOCK:
        path = _SESSION_VARS.get((session_id, side))
        if path and os.path.exists(path):
            return path
        return None

def clear_session_video(session_id: str, side: str) -> None:
    with _SESSION_LOCK:
        if (session_id, side) in _SESSION_VARS:
            del _SESSION_VARS[(session_id, side)]
