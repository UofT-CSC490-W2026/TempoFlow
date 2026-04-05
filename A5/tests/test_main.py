import json
from unittest.mock import AsyncMock, patch

from fastapi.testclient import TestClient

from src.main import app

client = TestClient(app)

def test_read_main():
    response = client.get("/")
    assert response.status_code == 200
    assert response.json() == {"message": "Audio Alignment API is running"}


def test_ebs_viewer_probe():
    response = client.get("/ebs_viewer.html")
    assert response.status_code == 200


def test_ebs_viewer_head():
    response = client.head("/ebs_viewer.html")
    assert response.status_code == 200


def test_process_requires_files():
    response = client.post("/api/process", files={})
    assert response.status_code == 400
    assert "required" in response.json()["error"]


def test_status_and_result_without_session():
    status_response = client.get("/api/status?session=missing-session")
    assert status_response.status_code == 200
    assert status_response.json()["status"] in {"idle", "error", "processing", "done"}

    result_response = client.get("/api/result?session=missing-session")
    assert result_response.status_code == 404


def test_overlay_status_unknown_job():
    response = client.get("/api/overlay/yolo/status?job_id=missing")
    assert response.status_code == 404


@patch("src.main.asyncio.to_thread", new_callable=AsyncMock)
def test_process_success(mock_to_thread):
    mock_to_thread.return_value = {"segments": [{"shared_start_sec": 0.0}]}
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    response = client.post("/api/process", files=files)
    assert response.status_code == 200
    assert "segments" in response.json()


@patch("src.main.asyncio.to_thread", new_callable=AsyncMock)
def test_process_uploads_raises(mock_to_thread):
    mock_to_thread.side_effect = RuntimeError("pipeline failed")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    response = client.post("/api/process", files=files)
    assert response.status_code == 500
    assert "pipeline failed" in response.json()["error"]


def test_status_with_segment_count():
    import src.main as main_mod

    main_mod.SESSION_RESULTS["segtest"] = {"segments": [1, 2, 3]}
    main_mod.SESSION_STATUS["segtest"] = "done"
    try:
        r = client.get("/api/status?session=segtest")
        assert r.status_code == 200
        body = r.json()
        assert body["segment_count"] == 3
        assert body["has_result"] is True
    finally:
        main_mod.SESSION_RESULTS.pop("segtest", None)
        main_mod.SESSION_STATUS.pop("segtest", None)


def test_result_ok_when_session_has_artifact():
    import src.main as main_mod

    artifact = {"segments": []}
    main_mod.SESSION_RESULTS["hasres"] = artifact
    try:
        r = client.get("/api/result?session=hasres")
        assert r.status_code == 200
        assert r.json() == artifact
    finally:
        main_mod.SESSION_RESULTS.pop("hasres", None)


@patch("src.main.save_upload")
def test_move_feedback_start_invalid_ebs_json(mock_save, tmp_path):
    mock_save.return_value = str(tmp_path / "vid.mp4")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {"segment_index": "0", "ebs_data_json": "not valid json{{{", "session_id": "s1"}
    r = client.post("/api/move-feedback/start", files=files, data=data)
    assert r.status_code == 400
    assert "valid JSON" in r.json()["error"]


@patch("src.main.save_upload")
def test_move_feedback_start_segment_out_of_range(mock_save, tmp_path):
    mock_save.return_value = str(tmp_path / "vid.mp4")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {
        "segment_index": "0",
        "ebs_data_json": json.dumps({"segments": []}),
        "session_id": "s2",
    }
    r = client.post("/api/move-feedback/start", files=files, data=data)
    assert r.status_code == 400
    assert "out of range" in r.json()["error"]


def test_move_feedback_status_unknown_job():
    r = client.get("/api/move-feedback/status?job_id=00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


def test_move_feedback_result_unknown_job():
    r = client.get("/api/move-feedback/result?job_id=00000000-0000-0000-0000-000000000000")
    assert r.status_code == 404


def test_move_feedback_result_not_ready():
    import src.main as main_mod

    jid = "job-not-ready"
    main_mod.MOVE_FEEDBACK_JOBS[jid] = {
        "status": "processing",
        "segment_index": 0,
        "error": None,
    }
    try:
        r = client.get(f"/api/move-feedback/result?job_id={jid}")
        assert r.status_code == 409
        assert r.json()["status"] == "processing"
    finally:
        main_mod.MOVE_FEEDBACK_JOBS.pop(jid, None)


@patch("src.main.save_upload")
@patch("src.main.asyncio.to_thread")
def test_move_feedback_sync_pipeline_error(mock_to_thread, mock_save, tmp_path):
    mock_save.return_value = str(tmp_path / "vid.mp4")
    mock_to_thread.side_effect = RuntimeError("EBS failed")

    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {"segment_index": "0", "session_id": "no-ebs"}
    r = client.post("/api/move-feedback", files=files, data=data)
    assert r.status_code == 500
    assert "EBS failed" in r.json()["error"]


@patch("src.main.run_move_feedback_pipeline", return_value={"ok": True})
def test_move_feedback_worker_success(mock_pipeline, tmp_path):
    import src.main as main_mod

    ref = tmp_path / "r.mp4"
    usr = tmp_path / "u.mp4"
    ref.write_bytes(b"x")
    usr.write_bytes(b"y")
    jid = "worker-direct"
    main_mod.MOVE_FEEDBACK_JOBS[jid] = {"status": "queued"}
    ebs = {"segments": [{"x": 1}]}
    main_mod._move_feedback_worker(jid, str(ref), str(usr), ebs, 0, None, None, True, False)
    assert main_mod.MOVE_FEEDBACK_JOBS[jid]["status"] == "done"
    assert main_mod.MOVE_FEEDBACK_JOBS[jid]["result"] == {"ok": True}
    assert not ref.exists()
    assert not usr.exists()
    del main_mod.MOVE_FEEDBACK_JOBS[jid]


@patch("src.main.run_move_feedback_pipeline", side_effect=RuntimeError("gemini down"))
def test_move_feedback_worker_error(mock_pipeline, tmp_path):
    import src.main as main_mod

    ref = tmp_path / "r.mp4"
    usr = tmp_path / "u.mp4"
    ref.write_bytes(b"x")
    usr.write_bytes(b"y")
    jid = "worker-err"
    main_mod.MOVE_FEEDBACK_JOBS[jid] = {"status": "queued"}
    main_mod._move_feedback_worker(jid, str(ref), str(usr), {"segments": [1]}, 0, None, None, True, False)
    assert main_mod.MOVE_FEEDBACK_JOBS[jid]["status"] == "error"
    assert "gemini down" in main_mod.MOVE_FEEDBACK_JOBS[jid]["error"]
    del main_mod.MOVE_FEEDBACK_JOBS[jid]


def _stub_move_feedback_worker(job_id, ref_path, user_path, ebs_data, segment_index, *_extra):
    import src.main as main_mod

    main_mod.MOVE_FEEDBACK_JOBS[job_id]["status"] = "done"
    main_mod.MOVE_FEEDBACK_JOBS[job_id]["result"] = {"piped": True}


@patch("src.main._move_feedback_worker", new=_stub_move_feedback_worker)
@patch("src.main.save_upload")
def test_move_feedback_start_success(mock_save, tmp_path):
    p1 = tmp_path / "mf_ref.mp4"
    p2 = tmp_path / "mf_user.mp4"
    mock_save.side_effect = [str(p1), str(p2)]
    p1.write_bytes(b"a")
    p2.write_bytes(b"b")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {
        "segment_index": "0",
        "ebs_data_json": json.dumps({"segments": [{"seg": 1}]}),
    }
    r = client.post("/api/move-feedback/start", files=files, data=data)
    assert r.status_code == 200
    body = r.json()
    assert "job_id" in body
    jid = body["job_id"]
    import src.main as main_mod

    assert main_mod.MOVE_FEEDBACK_JOBS.get(jid, {}).get("status") == "done"
    main_mod.MOVE_FEEDBACK_JOBS.pop(jid, None)


@patch("src.main._move_feedback_worker", new=_stub_move_feedback_worker)
@patch("src.main.save_upload")
def test_move_feedback_start_uses_session_results(mock_save, tmp_path):
    import src.main as main_mod

    main_mod.SESSION_RESULTS["sess_reuse"] = {"segments": [{"seg": 1}]}
    p1 = tmp_path / "mf_ref.mp4"
    p2 = tmp_path / "mf_user.mp4"
    mock_save.side_effect = [str(p1), str(p2)]
    p1.write_bytes(b"a")
    p2.write_bytes(b"b")
    try:
        files = {
            "ref_video": ("a.mp4", b"x", "video/mp4"),
            "user_video": ("b.mp4", b"y", "video/mp4"),
        }
        data = {"segment_index": "0", "session_id": "sess_reuse"}
        r = client.post("/api/move-feedback/start", files=files, data=data)
        assert r.status_code == 200
        jid = r.json()["job_id"]
        assert main_mod.MOVE_FEEDBACK_JOBS.get(jid, {}).get("status") == "done"
        main_mod.MOVE_FEEDBACK_JOBS.pop(jid, None)
    finally:
        main_mod.SESSION_RESULTS.pop("sess_reuse", None)


@patch("src.main._move_feedback_worker", new=_stub_move_feedback_worker)
@patch("src.main.asyncio.to_thread", new_callable=AsyncMock, return_value={"segments": [{"seg": 1}]})
@patch("src.main.save_upload")
def test_move_feedback_start_calls_process_videos_from_paths(
    mock_save, mock_to_thread, tmp_path,
):
    p1 = tmp_path / "mf_ref.mp4"
    p2 = tmp_path / "mf_user.mp4"
    mock_save.side_effect = [str(p1), str(p2)]
    p1.write_bytes(b"a")
    p2.write_bytes(b"y")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {"segment_index": "0", "session_id": "no-prior-artifact"}
    r = client.post("/api/move-feedback/start", files=files, data=data)
    assert r.status_code == 200
    jid = r.json()["job_id"]
    import src.main as main_mod

    assert main_mod.MOVE_FEEDBACK_JOBS.get(jid, {}).get("status") == "done"
    mock_to_thread.assert_called()
    main_mod.MOVE_FEEDBACK_JOBS.pop(jid, None)


@patch("src.main.save_upload")
@patch("src.main.asyncio.to_thread", side_effect=RuntimeError("EBS failed"))
def test_move_feedback_start_ebs_pipeline_failed(mock_to_thread, mock_save, tmp_path):
    mock_save.side_effect = [str(tmp_path / "a.mp4"), str(tmp_path / "b.mp4")]
    (tmp_path / "a.mp4").write_bytes(b"x")
    (tmp_path / "b.mp4").write_bytes(b"y")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {"segment_index": "0", "session_id": "fresh"}
    r = client.post("/api/move-feedback/start", files=files, data=data)
    assert r.status_code == 500
    assert "EBS pipeline failed" in r.json()["error"]


def test_move_feedback_status_ok():
    import src.main as main_mod

    jid = "job-status-ok"
    main_mod.MOVE_FEEDBACK_JOBS[jid] = {
        "status": "processing",
        "segment_index": 2,
        "error": None,
    }
    try:
        r = client.get(f"/api/move-feedback/status?job_id={jid}")
        assert r.status_code == 200
        body = r.json()
        assert body["job_id"] == jid
        assert body["status"] == "processing"
        assert body["segment_index"] == 2
    finally:
        main_mod.MOVE_FEEDBACK_JOBS.pop(jid, None)


def test_move_feedback_result_done():
    import src.main as main_mod

    jid = "job-done"
    main_mod.MOVE_FEEDBACK_JOBS[jid] = {
        "status": "done",
        "segment_index": 0,
        "error": None,
        "result": {"feedback": "ok"},
    }
    try:
        r = client.get(f"/api/move-feedback/result?job_id={jid}")
        assert r.status_code == 200
        assert r.json() == {"feedback": "ok"}
        assert jid not in main_mod.MOVE_FEEDBACK_JOBS
    finally:
        main_mod.MOVE_FEEDBACK_JOBS.pop(jid, None)


@patch("src.main.save_upload")
def test_move_feedback_sync_invalid_json(mock_save, tmp_path):
    mock_save.side_effect = [str(tmp_path / "a.mp4"), str(tmp_path / "b.mp4")]
    (tmp_path / "a.mp4").write_bytes(b"x")
    (tmp_path / "b.mp4").write_bytes(b"y")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {"segment_index": "0", "ebs_data_json": "{"}
    r = client.post("/api/move-feedback", files=files, data=data)
    assert r.status_code == 400


@patch("src.main.save_upload")
def test_move_feedback_sync_segment_out_of_range(mock_save, tmp_path):
    mock_save.side_effect = [str(tmp_path / "a.mp4"), str(tmp_path / "b.mp4")]
    (tmp_path / "a.mp4").write_bytes(b"x")
    (tmp_path / "b.mp4").write_bytes(b"y")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {"segment_index": "0", "ebs_data_json": json.dumps({"segments": []})}
    r = client.post("/api/move-feedback", files=files, data=data)
    assert r.status_code == 400


@patch("src.main.save_upload")
@patch("src.main.asyncio.to_thread", new_callable=AsyncMock)
def test_move_feedback_sync_success(mock_to_thread, mock_save, tmp_path):
    seen = {}

    async def mock_to_thread_impl(fn, /, *args, **kwargs):
        name = getattr(fn, "__name__", "")
        if name == "process_videos_from_paths":
            return {"segments": [{"seg": 1}]}
        if name == "run_move_feedback_pipeline":
            seen["yolo_context"] = kwargs["yolo_context"]
            return {"sync": {"ok": True}}
        raise AssertionError(f"unexpected fn {fn!r}")

    mock_to_thread.side_effect = mock_to_thread_impl
    mock_save.side_effect = [str(tmp_path / "a.mp4"), str(tmp_path / "b.mp4")]
    (tmp_path / "a.mp4").write_bytes(b"x")
    (tmp_path / "b.mp4").write_bytes(b"y")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {
        "segment_index": "0",
        "session_id": "sync-ok",
        "yolo_context_json": json.dumps({"segment_index": 0, "source": "yolo-hybrid-segment"}),
    }
    r = client.post("/api/move-feedback", files=files, data=data)
    assert r.status_code == 200
    assert r.json() == {"sync": {"ok": True}}
    assert mock_to_thread.call_count == 2
    assert seen["yolo_context"] == {"segment_index": 0, "source": "yolo-hybrid-segment"}


@patch("src.main.save_upload")
@patch("src.main.asyncio.to_thread", new_callable=AsyncMock)
def test_move_feedback_sync_generic_exception(mock_to_thread, mock_save, tmp_path):
    mock_save.side_effect = [str(tmp_path / "a.mp4"), str(tmp_path / "b.mp4")]
    (tmp_path / "a.mp4").write_bytes(b"x")
    (tmp_path / "b.mp4").write_bytes(b"y")

    async def mock_to_thread_impl(fn, /, *args, **kwargs):
        if getattr(fn, "__name__", "") == "process_videos_from_paths":
            return {"segments": [{"seg": 1}]}
        if getattr(fn, "__name__", "") == "run_move_feedback_pipeline":
            raise RuntimeError("gemini failed")
        raise AssertionError(fn)

    mock_to_thread.side_effect = mock_to_thread_impl
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {"segment_index": "0", "ebs_data_json": json.dumps({"segments": [{"seg": 1}]})}
    r = client.post("/api/move-feedback", files=files, data=data)
    assert r.status_code == 500
    assert "gemini failed" in r.json()["error"]


@patch("src.main.Path.unlink", side_effect=OSError("cannot unlink"))
@patch("src.main.run_move_feedback_pipeline", return_value={"ok": True})
def test_move_feedback_worker_finally_swallows_unlink_oserror(mock_pipeline, tmp_path):
    """Covers OSError branches in _move_feedback_worker finally (main.py ~63–64)."""
    import src.main as main_mod

    ref = tmp_path / "r.mp4"
    usr = tmp_path / "u.mp4"
    ref.write_bytes(b"x")
    usr.write_bytes(b"y")
    jid = "worker-unlink-os"
    main_mod.MOVE_FEEDBACK_JOBS[jid] = {"status": "queued"}
    main_mod._move_feedback_worker(jid, str(ref), str(usr), {"segments": [1]}, 0, None, None, True, False)
    assert main_mod.MOVE_FEEDBACK_JOBS[jid]["status"] == "done"
    del main_mod.MOVE_FEEDBACK_JOBS[jid]


class _ExplodingJobStore(dict):
    """Raises on assignment to simulate failure when registering a new job."""

    def __setitem__(self, key, value):
        raise RuntimeError("job store unavailable")


@patch("src.main.Path.unlink", side_effect=OSError("cannot unlink cleanup"))
@patch("src.main.save_upload")
def test_move_feedback_start_outer_exception_unlinks_temps(mock_save, mock_unlink, tmp_path):
    """Covers outer except, cleanup loop, and OSError on unlink (main.py ~191–198)."""
    import src.main as main_mod

    p1 = tmp_path / "mf_ref.mp4"
    p2 = tmp_path / "mf_user.mp4"
    mock_save.side_effect = [str(p1), str(p2)]
    p1.write_bytes(b"a")
    p2.write_bytes(b"b")

    old_jobs = main_mod.MOVE_FEEDBACK_JOBS
    main_mod.MOVE_FEEDBACK_JOBS = _ExplodingJobStore()
    try:
        files = {
            "ref_video": ("a.mp4", b"x", "video/mp4"),
            "user_video": ("b.mp4", b"y", "video/mp4"),
        }
        data = {
            "segment_index": "0",
            "ebs_data_json": json.dumps({"segments": [{"seg": 1}]}),
        }
        r = client.post("/api/move-feedback/start", files=files, data=data)
        assert r.status_code == 500
        assert "job store unavailable" in r.json()["error"]
        assert mock_unlink.call_count >= 1
    finally:
        main_mod.MOVE_FEEDBACK_JOBS = old_jobs


@patch("src.main.save_upload")
@patch("src.main.asyncio.to_thread", new_callable=AsyncMock)
def test_move_feedback_sync_uses_session_results(mock_to_thread, mock_save, tmp_path):
    """Covers SESSION_RESULTS reuse on sync route when ebs_data_json is omitted (main.py ~223–224)."""
    import src.main as main_mod

    main_mod.SESSION_RESULTS["sync_sess"] = {"segments": [{"seg": 1}]}

    async def mock_to_thread_impl(fn, /, *args, **kwargs):
        assert getattr(fn, "__name__", "") == "run_move_feedback_pipeline"
        return {"from": "session"}

    mock_to_thread.side_effect = mock_to_thread_impl
    mock_save.side_effect = [str(tmp_path / "a.mp4"), str(tmp_path / "b.mp4")]
    (tmp_path / "a.mp4").write_bytes(b"x")
    (tmp_path / "b.mp4").write_bytes(b"y")
    try:
        files = {
            "ref_video": ("a.mp4", b"x", "video/mp4"),
            "user_video": ("b.mp4", b"y", "video/mp4"),
        }
        data = {"segment_index": "0", "session_id": "sync_sess"}
        r = client.post("/api/move-feedback", files=files, data=data)
        assert r.status_code == 200
        assert r.json() == {"from": "session"}
        assert mock_to_thread.call_count == 1
    finally:
        main_mod.SESSION_RESULTS.pop("sync_sess", None)


@patch("src.main.Path.unlink", side_effect=OSError("cannot unlink"))
@patch("src.main.save_upload")
@patch("src.main.asyncio.to_thread", new_callable=AsyncMock)
def test_move_feedback_sync_finally_swallows_unlink_oserror(
    mock_to_thread, mock_save, tmp_path,
):
    """Covers OSError in sync route finally (main.py ~253–254)."""
    async def mock_to_thread_impl(fn, /, *args, **kwargs):
        name = getattr(fn, "__name__", "")
        if name == "process_videos_from_paths":
            return {"segments": [{"seg": 1}]}
        if name == "run_move_feedback_pipeline":
            return {"ok": True}
        raise AssertionError(f"unexpected fn {fn!r}")

    mock_to_thread.side_effect = mock_to_thread_impl
    mock_save.side_effect = [str(tmp_path / "a.mp4"), str(tmp_path / "b.mp4")]
    (tmp_path / "a.mp4").write_bytes(b"x")
    (tmp_path / "b.mp4").write_bytes(b"y")
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    data = {"segment_index": "0", "session_id": "sync-unlink"}
    r = client.post("/api/move-feedback", files=files, data=data)
    assert r.status_code == 200
    assert r.json() == {"ok": True}
