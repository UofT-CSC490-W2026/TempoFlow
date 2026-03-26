from unittest.mock import patch, MagicMock
from fastapi import UploadFile, HTTPException
from fastapi.testclient import TestClient
from src.alignment_and_segmentation.router import router, validate_video_file
import pytest
import numpy as np


# Create test app
from fastapi import FastAPI
app = FastAPI()
app.include_router(router)
client = TestClient(app)

def test_validate_video_valid():
    mock_file = MagicMock(spec=UploadFile)
    mock_file.content_type = "video/mp4"
    assert validate_video_file(mock_file) is None

def test_validate_video_invalid():
    mock_file = MagicMock(spec=UploadFile)
    mock_file.content_type = "image/jpeg"
    with pytest.raises(HTTPException) as exc:
        validate_video_file(mock_file)
    assert exc.value.status_code == 415

@patch("src.alignment_and_segmentation.router.load_audio_files")
@patch("src.alignment_and_segmentation.router.check_less_than_one_minute")
@patch("src.alignment_and_segmentation.router.check_audio_not_silent")
@patch("src.alignment_and_segmentation.router.extract_chroma")
@patch("src.alignment_and_segmentation.router.perform_alignment")
@patch("librosa.frames_to_time")
@patch("librosa.frames_to_samples")
@patch("src.alignment_and_segmentation.router.track_beats")
@patch("src.alignment_and_segmentation.router.estimate_downbeat_phase")
@patch("src.alignment_and_segmentation.router.generate_segments")
@patch("src.alignment_and_segmentation.router.map_segments_to_clips")
def test_align_audio_success(
    mock_map,
    mock_generate,
    mock_downbeat,
    mock_track_beats,
    mock_samples,
    mock_time, 
    mock_align, 
    mock_chroma, 
    mock_check_silent, 
    mock_check_len, 
    mock_load
):    
    # 1. Setup Alignment Mocks
    mock_load.return_value = (np.zeros(100), np.zeros(100), 22050)
    mock_check_len.return_value = None
    mock_check_silent.return_value = None
    mock_chroma.return_value = np.zeros((12, 10))
    # start_a, end_a, start_b, end_b (indices)
    mock_align.return_value = (0, 10, 5, 15)
    
    # Mock time/sample conversions
    mock_time.side_effect = lambda x, sr=22050: float(x) * 0.1
    mock_samples.side_effect = lambda x, hop_length=512: int(x) * 10

    # 2. Setup Segmentation Mocks
    # track_beats returns: beat_times, bpm, confidence_info, onset_env, beat_frames
    mock_track_beats.return_value = (
        np.array([0.0, 0.5, 1.0]), 
        120.0, 
        {"coefficient_of_variation": 0.05}, 
        np.zeros(100), 
        np.array([0, 5, 10])
    )
    mock_downbeat.return_value = 0
    mock_generate.return_value = ([0.0, 4.0], [[(0.0, 0.5), (0.5, 1.0)]]) 
    
    # map_segments_to_clips returns list of absolute (start, end, beat_times) tuples
    mock_map.side_effect = [
        [(10.0, 14.0, [(0.0, 0.5), (0.5, 1.0)])], 
        [(11.0, 15.0, [(0.0, 0.5), (0.5, 1.0)])]
    ]

    # Fake file upload
    files = {
        "file_a": ("a.mp4", b"content", "video/mp4"),
        "file_b": ("b.mp4", b"content", "video/mp4")
    }
    
    response = client.post("/api/process", files=files)
    assert response.status_code == 200, response.json()
    
    data = response.json()

    # Check Alignment
    assert data["alignment"]["file_a"]["start_time"] == 0.0
    assert data["alignment"]["file_a"]["end_time"] == 1.0
    
    # Check Segments
    assert len(data["clip_a_segments"]) == 1
    assert data["clip_a_segments"][0]["start_time"] == 10.0
    
    assert len(data["clip_b_segments"]) == 1
    assert data["clip_b_segments"][0]["start_time"] == 11.0
    
    # Check Confidence
    assert data["confidence"]["coefficient_of_variation"] == 0.05
    
    # Check Beat Times (now pairs)
    assert data["clip_a_segments"][0]["beat_times"] == [[0.0, 0.5], [0.5, 1.0]]
    assert data["clip_b_segments"][0]["beat_times"] == [[0.0, 0.5], [0.5, 1.0]]

@patch("src.alignment_and_segmentation.router.load_audio_files")
@patch("src.alignment_and_segmentation.router.check_less_than_one_minute")
@patch("src.alignment_and_segmentation.router.check_audio_not_silent")
@patch("src.alignment_and_segmentation.router.extract_chroma")
@patch("src.alignment_and_segmentation.router.perform_alignment")
@patch("librosa.frames_to_time")
@patch("librosa.frames_to_samples")
@patch("src.alignment_and_segmentation.router.track_beats")
def test_align_audio_track_beats_failure(
    mock_track_beats,
    mock_samples,
    mock_time, 
    mock_align, 
    mock_chroma, 
    mock_check_silent, 
    mock_check_len, 
    mock_load
):
    mock_load.return_value = (np.zeros(100), np.zeros(100), 22050)
    mock_align.return_value = (0, 10, 0, 10)
    mock_time.return_value = 0.0  # Set return value for time conversion
    mock_samples.return_value = 0 # Set return value for sample conversion
    mock_track_beats.side_effect = Exception("Beat tracking crashed")
    
    files = {
        "file_a": ("a.mp4", b"content", "video/mp4"),
        "file_b": ("b.mp4", b"content", "video/mp4")
    }
    response = client.post("/api/process", files=files)
    assert response.status_code == 500
    assert "Beat tracking failed" in response.json()["detail"]

@patch("src.alignment_and_segmentation.router.load_audio_files")
@patch("src.alignment_and_segmentation.router.check_less_than_one_minute")
@patch("src.alignment_and_segmentation.router.check_audio_not_silent")
@patch("src.alignment_and_segmentation.router.extract_chroma")
@patch("src.alignment_and_segmentation.router.perform_alignment")
@patch("librosa.frames_to_time")
@patch("librosa.frames_to_samples")
@patch("src.alignment_and_segmentation.router.track_beats")
def test_align_audio_irregular_rhythm(
    mock_track_beats,
    mock_samples,
    mock_time, 
    mock_align, 
    mock_chroma, 
    mock_check_silent, 
    mock_check_len, 
    mock_load
):
    mock_load.return_value = (np.zeros(100), np.zeros(100), 22050)
    mock_align.return_value = (0, 10, 0, 10)
    mock_time.return_value = 0.0
    mock_samples.return_value = 0
    mock_track_beats.return_value = ([], 0, {"coefficient_of_variation": 1.5}, [], [])
    
    files = {
        "file_a": ("a.mp4", b"content", "video/mp4"),
        "file_b": ("b.mp4", b"content", "video/mp4")
    }
    response = client.post("/api/process", files=files)
    assert response.status_code == 422
    assert "Rhythm too irregular" in response.json()["detail"]

@patch("src.alignment_and_segmentation.router.load_audio_files")
@patch("src.alignment_and_segmentation.router.check_less_than_one_minute")
@patch("src.alignment_and_segmentation.router.check_audio_not_silent")
@patch("src.alignment_and_segmentation.router.extract_chroma")
@patch("src.alignment_and_segmentation.router.perform_alignment")
@patch("librosa.frames_to_time")
@patch("librosa.frames_to_samples")
@patch("src.alignment_and_segmentation.router.track_beats")
@patch("src.alignment_and_segmentation.router.estimate_downbeat_phase")
def test_align_audio_segmentation_failure(
    mock_downbeat,
    mock_track_beats,
    mock_samples,
    mock_time, 
    mock_align, 
    mock_chroma, 
    mock_check_silent, 
    mock_check_len, 
    mock_load
):
    mock_load.return_value = (np.zeros(100), np.zeros(100), 22050)
    mock_align.return_value = (0, 10, 0, 10)
    mock_time.return_value = 0.0
    mock_samples.return_value = 0
    mock_track_beats.return_value = ([], 120, {"coefficient_of_variation": 0.1}, [], [])
    mock_downbeat.side_effect = ValueError("Not enough beats")
    
    files = {
        "file_a": ("a.mp4", b"content", "video/mp4"),
        "file_b": ("b.mp4", b"content", "video/mp4")
    }
    response = client.post("/api/process", files=files)
    assert response.status_code == 422
    assert "Segmentation failed" in response.json()["detail"]

@patch("src.alignment_and_segmentation.router.load_audio_files")
def test_align_audio_load_error(mock_load):
    mock_load.side_effect = Exception("Load failed")
    files = {
        "file_a": ("a.mp4", b"content", "video/mp4"),
        "file_b": ("b.mp4", b"content", "video/mp4")
    }
    response = client.post("/api/process", files=files)
    assert response.status_code == 422
    assert "Error processing audio" in response.json()["detail"]

@patch("src.alignment_and_segmentation.router.load_audio_files")
@patch("src.alignment_and_segmentation.router.check_less_than_one_minute")
def test_align_audio_too_long(mock_check_len, mock_load):
    # 1. Provide standard dummy data
    mock_load.return_value = (np.array([1]), np.array([1]), 22050)
    
    # 2. Force the length checker to throw an error
    mock_check_len.side_effect = ValueError("mocked too long error")
    
    files = {
        "file_a": ("a.mp4", b"content", "video/mp4"),
        "file_b": ("b.mp4", b"content", "video/mp4")
    }
    response = client.post("/api/process", files=files)
    
    assert response.status_code == 422
    # 3. Assert it catches our mocked error
    assert "mocked too long error" in response.json()["detail"]

@patch("src.alignment_and_segmentation.router.load_audio_files")
@patch("src.alignment_and_segmentation.router.check_less_than_one_minute")
@patch("src.alignment_and_segmentation.router.check_audio_not_silent")
def test_align_audio_silent_error(
    mock_check_silent, 
    mock_check_len, 
    mock_load
):
    mock_load.return_value = (np.array([0]), np.array([0]), 22050)
    mock_check_len.return_value = None
    mock_check_silent.side_effect = ValueError("Silent audio")

    files = {
        "file_a": ("a.mp4", b"content", "video/mp4"),
        "file_b": ("b.mp4", b"content", "video/mp4")
    }
    response = client.post("/api/process", files=files)
    assert response.status_code == 422
    assert "Silent audio" in response.json()["detail"]