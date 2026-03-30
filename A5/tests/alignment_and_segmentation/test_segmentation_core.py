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
    onset_env = np.array([1, 10, 1, 10, 0, 0])
    beat_frames = np.array([0, 1, 2, 3])
    beats_per_seg = 2
    
    best_k = estimate_downbeat_phase(onset_env, beat_frames, beats_per_seg)
    assert best_k == 1

def test_estimate_downbeat_phase_not_enough_beats():
    beat_frames = np.array([1, 2]) # 2 beats
    beats_per_seg = 4
    onset_env = np.zeros(10)
    
    with pytest.raises(ValueError, match="Not enough beats"):
        estimate_downbeat_phase(onset_env, beat_frames, beats_per_seg)

def test_estimate_downbeat_phase_out_of_bounds_clip():
    onset_env = np.zeros(10) # max index 9
    beat_frames = np.array([0, 12]) # 12 > 9
    beats_per_seg = 1
    
    best_k = estimate_downbeat_phase(onset_env, beat_frames, beats_per_seg)
    assert best_k == 0


# ==========================================
# generate_segments Tests (tuple beat times)
# ==========================================

def test_generate_segments_all_full():
    # 9 beats: 0, 1, 2, ..., 8
    beat_times = np.arange(9.0) 
    downbeat_offset = 0
    beats_per_seg = 4
    
    # Seg 1: indices 0..3, Seg 2: indices 4..7
    boundaries, seg_beats = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    
    assert boundaries == [0.0, 4.0, 8.0]
    
    # Beat pairs per segment (N-1 pairs for N beats in range)
    assert len(seg_beats) == 2
    # Seg 0: beats 0,1,2,3 -> pairs (0,1),(1,2),(2,3)
    assert seg_beats[0] == [(0.0, 1.0), (1.0, 2.0), (2.0, 3.0)]
    # Seg 1: beats 4,5,6,7 -> pairs (4,5),(5,6),(6,7)
    assert seg_beats[1] == [(4.0, 5.0), (5.0, 6.0), (6.0, 7.0)]

def test_generate_segments_with_offset():
    beat_times = np.arange(9.0)
    downbeat_offset = 1
    beats_per_seg = 4
    
    boundaries, seg_beats = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    assert boundaries == [1.0, 5.0, 9.0]
    
    assert len(seg_beats) == 2
    # Seg 0: beats 1,2,3,4 -> pairs (1,2),(2,3),(3,4)
    assert seg_beats[0] == [(1.0, 2.0), (2.0, 3.0), (3.0, 4.0)]
    # Seg 1: beats 5,6,7,8 -> pairs (5,6),(6,7),(7,8)
    assert seg_beats[1] == [(5.0, 6.0), (6.0, 7.0), (7.0, 8.0)]
    
def test_generate_segments_not_enough_for_one():
    beat_times = np.array([0.0, 1.0]) # 2 beats
    downbeat_offset = 0
    beats_per_seg = 4
    
    boundaries, seg_beats = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    assert boundaries == []
    assert seg_beats == []

def test_generate_segments_extrapolate_single_beat():
    # 2 beats, seg size 1, offset 1
    beat_times = np.array([10.0, 11.0])
    downbeat_offset = 1 
    beats_per_seg = 1
    
    # end_idx=2, out of bounds -> extrapolate end=12.0
    # beats_end = min(2,2) = 2, range(1,1) = empty -> no pairs
    boundaries, seg_beats = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    assert boundaries == [11.0, 12.0]
    
    assert len(seg_beats) == 1
    # Only 1 beat in segment, no j+1 available in range -> empty pairs
    assert seg_beats[0] == []

def test_generate_segments_extrapolate_one_beat_fallback():
    # 1 beat, seg size 1
    beat_times = np.array([10.0])
    downbeat_offset = 0
    beats_per_seg = 1
    
    boundaries, seg_beats = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    assert boundaries == [10.0, 10.5]
    
    assert len(seg_beats) == 1
    # range(0, 0) = empty -> no pairs
    assert seg_beats[0] == []


# ==========================================
# New: Per-segment beat pair specific tests
# ==========================================

def test_generate_segments_beat_pairs_8_beat():
    """Verify 8-beat segments have 7 beat pairs each."""
    # 17 beats: enough for exactly 2 full 8-beat segments
    beat_times = np.arange(17.0) * 0.5  # 0.0, 0.5, 1.0, ..., 8.0
    downbeat_offset = 0
    beats_per_seg = 8
    
    boundaries, seg_beats = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    
    assert len(boundaries) == 3  # 3 boundary points = 2 segments
    assert len(seg_beats) == 2
    
    # Each segment should have 7 pairs (8 beats -> 7 intervals)
    assert len(seg_beats[0]) == 7
    assert len(seg_beats[1]) == 7
    
    # First segment: beats 0-7 -> pairs (0.0,0.5),(0.5,1.0),...,(3.0,3.5)
    expected_0 = [(i * 0.5, (i + 1) * 0.5) for i in range(7)]
    assert seg_beats[0] == expected_0
    
    # Second segment: beats 8-15 -> pairs
    expected_1 = [(i * 0.5, (i + 1) * 0.5) for i in range(8, 15)]
    assert seg_beats[1] == expected_1

def test_generate_segments_beat_pairs_last_segment_extrapolated():
    """When last segment is extrapolated, beat pairs still use actual beats."""
    # 8 beats exactly -> 1 segment, end is extrapolated
    beat_times = np.arange(8.0)  # 0..7
    downbeat_offset = 0
    beats_per_seg = 8
    
    boundaries, seg_beats = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    
    assert boundaries == [0.0, 8.0]
    assert len(seg_beats) == 1
    # 8 beats -> 7 pairs: (0,1),(1,2),...,(6,7)
    assert len(seg_beats[0]) == 7
    assert seg_beats[0] == [(float(i), float(i + 1)) for i in range(7)]

def test_generate_segments_beat_pairs_with_nonzero_offset():
    """Beat pairs respect the downbeat offset correctly."""
    beat_times = np.array([0.0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5])
    downbeat_offset = 2
    beats_per_seg = 4
    
    # Seg 0: indices 2..5 -> beats 1.0,1.5,2.0,2.5 -> 3 pairs
    # Seg 1: indices 6..9 -> beats 3.0,3.5,4.0,4.5 -> 3 pairs
    
    boundaries, seg_beats = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    
    assert len(seg_beats) == 2
    assert seg_beats[0] == [(1.0, 1.5), (1.5, 2.0), (2.0, 2.5)]
    assert seg_beats[1] == [(3.0, 3.5), (3.5, 4.0), (4.0, 4.5)]

def test_generate_segments_consistent_beat_pair_count():
    """The number of per-segment beat lists matches the number of boundary pairs."""
    beat_times = np.arange(25.0)
    downbeat_offset = 0
    beats_per_seg = 8
    
    boundaries, seg_beats = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    
    num_segments = len(boundaries) - 1
    assert num_segments == len(seg_beats)
    assert num_segments == 3  # 0-8, 8-16, 16-24
    
    # Each full 8-beat segment should have 7 pairs
    for sb in seg_beats:
        assert len(sb) == 7
