import numpy as np
import pytest
import librosa
from unittest.mock import MagicMock, patch
from fastapi import UploadFile
from src.alignment_and_segmentation.utils import (
    check_less_than_one_minute,
    load_audio_files,
    check_audio_not_silent,
    extract_chroma,
)

@pytest.fixture
def mock_upload_file():
    """Create a mock UploadFile object."""
    mock_file = MagicMock(spec=UploadFile)
    mock_file.file = MagicMock()
    # Mocking soundfile.info to return a valid samplerate
    with patch("soundfile.info") as mock_info:
        mock_info.return_value.samplerate = 22050
        yield mock_file

def test_load_audio_files_same_sr(mock_upload_file):
    """Test loading files with identical sample rates."""
    with patch("librosa.load") as mock_load:
        # Simulate both files having 22050 sr
        mock_load.side_effect = [
            (np.zeros(100), 22050),
            (np.zeros(100), 22050)
        ]
        
        y_a, y_b, sr = load_audio_files(mock_upload_file, mock_upload_file)
        
        assert sr == 22050
        assert len(y_a) == 100
        assert len(y_b) == 100
        # Should not resample
        assert mock_load.call_count == 2

def test_load_audio_files_resample(mock_upload_file):
    """Test loading files where resampling is required."""
    with patch("librosa.load") as mock_load, \
         patch("librosa.resample") as mock_resample, \
         patch("soundfile.info") as mock_sf_info:
        
        # File A: 44100, File B: 22050
        # Should pick 22050 as target
        mock_sf_info.side_effect = [
            MagicMock(samplerate=44100),
            MagicMock(samplerate=22050)
        ]

        # librosa.load shouldn't need side_effect return values for logic check if it's just returning audio
        # but let's provide dummy data
        mock_load.return_value = (np.zeros(100), 22050)
        
        y_a, y_b, sr = load_audio_files(mock_upload_file, mock_upload_file)
        
        assert sr == 22050
        
        # In the optimized implementation, librosa.load is called with sr=target_sr
        # for ALL files, so librosa handles the resampling.
        # We expect librosa.load to be called twice, both with sr=22050
        assert mock_load.call_count == 2
        
        # Check call arguments for both calls
        # Since it runs in threads, the order might vary, but both should use sr=22050
        call_args_list = mock_load.call_args_list
        for call in call_args_list:
             _, kwargs = call
             assert kwargs['sr'] == 22050

def test_load_audio_files_resample_file_b(mock_upload_file):
    """Test loading files where File B requires resampling instead of File A."""
    with patch("librosa.load") as mock_load, \
         patch("librosa.resample") as mock_resample, \
         patch("soundfile.info") as mock_sf_info:
        
        # File A: 22050, File B: 44100
        # Should pick 22050 as target
        mock_sf_info.side_effect = [
            MagicMock(samplerate=22050),
            MagicMock(samplerate=44100)
        ]

        mock_load.return_value = (np.zeros(100), 22050)
        
        y_a, y_b, sr = load_audio_files(mock_upload_file, mock_upload_file)
        
        assert sr == 22050
        
        assert mock_load.call_count == 2
        for call in mock_load.call_args_list:
             _, kwargs = call
             assert kwargs['sr'] == 22050

def test_check_less_than_one_minute_valid():
    sr = 22050
    y = np.zeros(sr * 30)  # 30 seconds
    check_less_than_one_minute(y, sr)

def test_check_less_than_one_minute_invalid():
    sr = 22050
    y = np.zeros(sr * 70)  # 70 seconds
    with pytest.raises(ValueError, match="too long"):
        check_less_than_one_minute(y, sr)

def test_check_audio_not_silent_valid():
    """Test with non-silent audio."""
    # Create simple sine wave
    sr = 22050
    t = np.linspace(0, 1, sr)
    y = np.sin(2 * np.pi * 440 * t)  # 440 Hz
    
    check_audio_not_silent(y)

def test_check_audio_not_silent_completely_silent():
    """Test with zeros."""
    y = np.zeros(22050)
    with pytest.raises(ValueError, match="completely silent"):
        check_audio_not_silent(y)

def test_check_audio_not_silent_effectively_silent():
    """Test with very quiet noise below threshold."""
    # Create random noise with tiny amplitude
    y = np.random.randn(22050) * 1e-6
    with pytest.raises(ValueError, match="effectively silent"):
        check_audio_not_silent(y)

def test_extract_chroma():
    """Test chroma extraction call."""
    with patch("librosa.feature.chroma_stft") as mock_chroma:
        y = np.zeros(22050)
        sr = 22050
        extract_chroma(y, sr)
        mock_chroma.assert_called_once_with(y=y, sr=sr)

# --- New tests for map_segments_to_clips ---
from src.alignment_and_segmentation.utils import map_segments_to_clips

def test_map_segments_to_clips_valid():
    """Test normal mapping logic."""
    points = [0.0, 4.0, 8.0]
    clip_start = 10.0
    clip_end = 20.0
    
    # Expected: [(10.0, 14.0, []), (14.0, 18.0, [])]
    result = map_segments_to_clips(points, clip_start, clip_end)
    
    assert len(result) == 2
    assert result[0] == (10.0, 14.0, [])
    assert result[1] == (14.0, 18.0, [])

def test_map_segments_to_clips_empty():
    """Test with empty points."""
    assert map_segments_to_clips([], 10.0, 20.0) == []
    assert map_segments_to_clips([0.0], 10.0, 20.0) == []

def test_map_segments_to_clips_out_of_bounds():
    """Test mapping that exceeds clip end."""
    points = [0.0, 5.0, 15.0] # 15.0 would map to 10+15=25 > 20
    clip_start = 10.0
    clip_end = 20.0
    
    # result[0]: 10->15 (ok)
    # result[1]: 15->25 (starts at 15<20, but ends at 25)
    # The logic says: if abs_start >= clip_end: continue.
    # 15 < 20, so it engages.
    
    result = map_segments_to_clips(points, clip_start, clip_end)
    
    assert len(result) == 2
    assert result[0] == (10.0, 15.0, [])
    assert result[1] == (15.0, 25.0, [])

def test_map_segments_to_clips_strict_cutoff():
    """Test segments that start after clip end."""
    points = [11.0, 15.0] # 11 maps to 10+11=21 > 20
    clip_start = 10.0
    clip_end = 20.0
    
    result = map_segments_to_clips(points, clip_start, clip_end)
    assert result == []

    # RMS > threshold (-60dB is roughly 0.001)
    y = np.random.rand(1000) * 0.1  # Not silent
    check_audio_not_silent(y, threshold_db=-60.0)

def test_check_audio_not_silent_too_quiet():
    # Very small amplitude
    y = np.random.rand(1000) * 0.0000001
    with pytest.raises(ValueError, match="effectively silent"):
        check_audio_not_silent(y, threshold_db=-60.0)

def test_check_audio_not_silent_absolute_zero():
    y = np.zeros(1000)
    with pytest.raises(ValueError, match="completely silent"):
        check_audio_not_silent(y)

def test_extract_chroma():
    with patch("librosa.feature.chroma_stft") as mock_chroma:
        y = np.zeros(1000)
        sr = 22050
        mock_chroma.return_value = np.zeros((12, 10))
        
        chroma = extract_chroma(y, sr)
        
        assert chroma.shape == (12, 10)
        mock_chroma.assert_called_once_with(y=y, sr=sr)


# --- New tests for map_segments_to_clips with beat times ---

def test_map_segments_to_clips_with_beat_times():
    """Test that segment_beat_times are passed through correctly."""
    points = [0.0, 4.0, 8.0]
    clip_start = 10.0
    clip_end = 20.0
    beat_times = [[(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)], [(4.0, 5.0), (5.0, 6.0), (6.0, 7.0)]]
    
    result = map_segments_to_clips(points, clip_start, clip_end, segment_beat_times=beat_times)
    
    assert len(result) == 2
    assert result[0] == (10.0, 14.0, [(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)])
    assert result[1] == (14.0, 18.0, [(4.0, 5.0), (5.0, 6.0), (6.0, 7.0)])

def test_map_segments_to_clips_beat_times_none():
    """Without beat_times, each tuple has an empty list."""
    points = [0.0, 4.0]
    result = map_segments_to_clips(points, 0.0, 10.0)
    
    assert len(result) == 1
    assert result[0] == (0.0, 4.0, [])

def test_map_segments_to_clips_beat_times_filtered():
    """Beat times for filtered-out segments are skipped."""
    points = [0.0, 5.0, 15.0]
    clip_start = 0.0
    clip_end = 20.0
    beat_times = [[(0.0, 1.0), (1.0, 2.0)], [(5.0, 6.0), (6.0, 7.0)]]
    
    result = map_segments_to_clips(points, clip_start, clip_end, segment_beat_times=beat_times)
    assert len(result) == 2
    assert result[0][2] == [(0.0, 1.0), (1.0, 2.0)]
    assert result[1][2] == [(5.0, 6.0), (6.0, 7.0)]
