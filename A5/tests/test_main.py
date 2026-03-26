import json
from unittest.mock import patch

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


@patch("src.main.process_uploads")
def test_process_success(mock_process):
    mock_process.return_value = {"segments": [{"shared_start_sec": 0.0}]}
    files = {
        "ref_video": ("a.mp4", b"x", "video/mp4"),
        "user_video": ("b.mp4", b"y", "video/mp4"),
    }
    response = client.post("/api/process", files=files)
    assert response.status_code == 200
    assert "segments" in response.json()


@patch("src.main.process_uploads")
def test_process_uploads_raises(mock_process):
    mock_process.side_effect = RuntimeError("pipeline failed")
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
