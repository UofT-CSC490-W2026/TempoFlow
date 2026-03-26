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
