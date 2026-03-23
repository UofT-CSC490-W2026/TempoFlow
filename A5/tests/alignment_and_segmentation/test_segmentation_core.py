import numpy as np
import pytest
from unittest.mock import patch, MagicMock
from src.alignment_and_segmentation.segmentation_core import (
    track_beats, 
    estimate_downbeat_phase, 
    generate_segments
)

# ==========================================
# track_beats Tests
# ==========================================

@patch("librosa.onset.onset_strength")
@patch("librosa.beat.beat_track")
@patch("librosa.frames_to_time")
def test_track_beats_normal(mock_ftt, mock_beat_track, mock_onset):
    # Setup Mocks
    mock_onset.return_value = np.zeros(100) # onset env
    # beat_track returns: (tempo, beat_frames)
    mock_beat_track.return_value = (120.0, np.array([10, 20, 30]))
    # frames_to_time returns times in seconds
    mock_ftt.return_value = np.array([0.5, 1.0, 1.5]) 
    
    audio = np.zeros(22050)
    sr = 22050
    
    beat_times, bpm, conf, onset_env, frames = track_beats(audio, sr)
    
    assert len(beat_times) == 3
    assert bpm == 120.0
    assert conf["num_beats"] == 3
    assert conf["estimated_bpm"] == 120.0
    # Perfect 0.5s intervals -> std dev 0 -> CV 0
    assert conf["coefficient_of_variation"] == 0.0

@patch("librosa.onset.onset_strength")
@patch("librosa.beat.beat_track")
@patch("librosa.frames_to_time")
def test_track_beats_single_beat(mock_ftt, mock_beat_track, mock_onset):
    # Setup: Only 1 beat found
    mock_onset.return_value = np.zeros(100)
    mock_beat_track.return_value = (60.0, np.array([10]))
    mock_ftt.return_value = np.array([0.5])
    
    audio = np.zeros(22050)
    sr = 22050
    
    beat_times, bpm, conf, onset_env, frames = track_beats(audio, sr)
    
    # Logic: if len < 2, stats are 0 and CV is inf
    assert conf["num_beats"] == 1
    assert conf["coefficient_of_variation"] == float("inf")


# ==========================================
# estimate_downbeat_phase Tests
# ==========================================

def test_estimate_downbeat_phase_simple():
    # 4 beats, beats_per_seg = 2
    # Phases: 0 or 1.
    # Onset Env: [0, 10, 0, 10, 0, 10...]
    # Beat Frames: [1, 3, 5, 7] -> env values 10, 10, 10, 10
    
    # Let's construct onset_env so phase 0 is weak (1) and phase 1 is strong (10)
    # Frames: 0, 1, 2, 3
    # Env at 0=1, at 1=10, at 2=1, at 3=10
    onset_env = np.array([1, 10, 1, 10, 0, 0])
    beat_frames = np.array([0, 1, 2, 3])
    beats_per_seg = 2
    
    # Phase 0 (indices 0, 2): avg(1, 1) = 1
    # Phase 1 (indices 1, 3): avg(10, 10) = 10
    # Should pick phase 1 (index 1 in beat_frames) -> returns 1
    
    best_k = estimate_downbeat_phase(onset_env, beat_frames, beats_per_seg)
    assert best_k == 1

def test_estimate_downbeat_phase_not_enough_beats():
    beat_frames = np.array([1, 2]) # 2 beats
    beats_per_seg = 4
    onset_env = np.zeros(10)
    
    with pytest.raises(ValueError, match="Not enough beats"):
        estimate_downbeat_phase(onset_env, beat_frames, beats_per_seg)

def test_estimate_downbeat_phase_out_of_bounds_clip():
    # Ensure it doesn't crash if beat frame > onset_env length
    onset_env = np.zeros(10) # max index 9
    beat_frames = np.array([0, 12]) # 12 > 9
    beats_per_seg = 1
    
    # Should clip 12 -> 9. Env[9]=0. Mean is 0.
    best_k = estimate_downbeat_phase(onset_env, beat_frames, beats_per_seg)
    assert best_k == 0


# ==========================================
# generate_segments Tests
# ==========================================

def test_generate_segments_all_full():
    # 9 beats: 0, 1, 2, ..., 8
    beat_times = np.arange(9.0) 
    downbeat_offset = 0
    beats_per_seg = 4
    
    # Seg 1: indices 0 to 4 (values 0.0 to 4.0)
    # Seg 2: indices 4 to 8 (values 4.0 to 8.0)
    # Next start index is 8. 8+4=12 > 9. Stop.
    
    segments = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    
    # Returns POINTS: start1, end1/start2, end2
    # [0.0, 4.0, 8.0]
    
    assert segments == [0.0, 4.0, 8.0]

def test_generate_segments_with_offset():
    # 9 beats: 0..8
    beat_times = np.arange(9.0)
    downbeat_offset = 1 # Start at beat 1 (1.0s)
    beats_per_seg = 4
    
    # Seg 1: indices 1 to 5 (values 1.0 to 5.0)
    # Start idx becomes 5. 5+4=9.
    # Seg 2: indices 5 to 9. 9 is out of bounds (len is 9).
    # Logic: if end_idx >= num_beats: extrapolate.
    # beat_times[8] + interval. interval = 8-7=1. end = 8+1=9.0.
    # end_idx is 9 (== num_beats, out of bounds of array 0..8).
    
    # Wait, my logic in generate_segments:
    # while start_idx + beats_per_seg <= num_beats:
    # 1 + 4 = 5 <= 9 (True). Append 1.0, 5.0. start -> 5.
    # 5 + 4 = 9 <= 9 (True). Append 9.0 (extrapolated). start -> 9.
    # 9 + 4 = 13 > 9 (False).
    
    # So expected result: [1.0, 5.0, 9.0]
    
    segments = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    assert segments == [1.0, 5.0, 9.0]
    
def test_generate_segments_not_enough_for_one():
    beat_times = np.array([0.0, 1.0]) # 2 beats
    downbeat_offset = 0
    beats_per_seg = 4
    
    # 0 + 4 = 4 > 2. Loop doesn't start.
    segments = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    assert segments == []

def test_generate_segments_extrapolate_single_beat():
    # Edge case: exactly enough beats but last one needs extrapolation from minimal info
    # 2 beats (0, 1), seg size 1.
    beat_times = np.array([10.0, 11.0])
    downbeat_offset = 1 
    beats_per_seg = 1
    
    # loop: 1 + 1 = 2 <= 2.
    # start_idx = 1 (11.0).
    # end_idx = 2 (out of bounds).
    # Extrapolate: len >= 2. last_interval = 11-10 = 1.
    # end_time = 11 + 1 = 12.0.
    
    segments = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    # point 1: beat[1] -> 11.0
    # point 2: extrapolated -> 12.0
    assert segments == [11.0, 12.0]

def test_generate_segments_extrapolate_one_beat_fallback():
    # Covers last_interval = 0.5 case
    # Num beats < 2 (so 1 beat). Beats per seg = 1.
    beat_times = np.array([10.0])
    downbeat_offset = 0
    beats_per_seg = 1
    
    # loop: 0 + 1 = 1 <= 1 (True)
    # start_idx = 0.
    # end_idx = 1 (out of bounds for array size 1).
    # num_beats (1) < 2 -> False.
    # else: last_interval = 0.5.
    # end_time = 10.0 + 0.5 = 10.5.
    
    segments = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    assert segments == [10.0, 10.5]
