import numpy as np
import pytest
from src.alignment_and_segmentation.alignment_core import (
    compute_similarity_matrix,
    smith_waterman,
    traceback,
    perform_alignment,
)

@pytest.fixture
def sample_chroma():
    """Create deterministic dummy chroma features."""
    chroma_a = np.array([
        [1, 0, 1, 0, 1],
        [0, 1, 0, 1, 0]
    ])
    
    chroma_b = np.array([
        [1, 0, 1, 0, 1],
        [0, 1, 0, 1, 0]
    ])
    return chroma_a, chroma_b

# ==========================================
# POSITIVE TESTS (Important Use Cases)
# ==========================================

def test_compute_similarity_matrix_identical():
    # WHY: Core use case. Verifies that identical audio frames return a perfect 
    # cosine similarity score of 1.0, which is the mathematical foundation of our DP matrix.
    a = np.array([[1], [0]])  
    b = np.array([[1], [0]]) 
    S = compute_similarity_matrix(a, b)
    
    assert S.shape == (1, 1)
    assert np.isclose(S[0, 0], 1.0)

def test_compute_similarity_matrix_orthogonal():
    # WHY: Core use case. Verifies that completely mismatched audio frames (orthogonal vectors) 
    # return a similarity of 0.0, ensuring bad matches are properly penalized.
    a = np.array([[1], [0]])
    c = np.array([[0], [1]])
    S_ortho = compute_similarity_matrix(a, c)
    
    assert np.isclose(S_ortho[0, 0], 0.0)

def test_smith_waterman_perfect_match():
    # WHY: Core use case. Tests the dynamic programming accumulation. 
    # If the similarity matrix is perfect (1.0s on the diagonal), the score should 
    # accumulate linearly minus the bias.
    S = np.eye(3) 
    H = smith_waterman(S, match_score_bias=0.5)
    
    # Expected accumulation: 0 -> 0.5 -> 1.0 -> 1.5
    assert H.shape == (4, 4)
    assert H[3, 3] == 1.5
    assert H[2, 2] == 1.0
    assert H[1, 1] == 0.5

def test_smith_waterman_offset():
    # WHY: Core use case. Tests that the algorithm can find a perfect match even if it starts 
    # at an offset (e.g., Clip B is a snippet from the middle of Clip A). 
    S = np.zeros((5, 5))
    S[2, 0] = 1.0
    S[3, 1] = 1.0
    S[4, 2] = 1.0
    
    H = smith_waterman(S, match_score_bias=0.5)
    
    assert H[5, 3] == 1.5
    assert H[4, 2] == 1.0
    assert H[3, 1] == 0.5

def test_smith_waterman_all_ones():
    # WHY: Stress test for accumulation. If every frame is a perfect match,
    # the scores should accumulate linearly along the diagonal: 0.5, 1.0, 1.5...
    # This ensures the H[i-1, j-1] recurrence relation is working perfectly.
    S = np.ones((3, 3))
    bias = 0.5
    H = smith_waterman(S, match_score_bias=bias)
    
    # Expected H matrix (4x4 due to padding):
    # Row 0 and Col 0 are always 0.
    # H[1,1] = 0 + (1 - 0.5) = 0.5
    # H[2,2] = 0.5 + (1 - 0.5) = 1.0
    # H[3,3] = 1.0 + (1 - 0.5) = 1.5
    expected_H = np.array([
        [0. , 0. , 0. , 0. ],
        [0. , 0.5, 0.5, 0.5],
        [0. , 0.5, 1.0, 1.0],
        [0. , 0.5, 1.0, 1.5]
    ], dtype=np.float32)
    
    assert np.array_equal(H, expected_H)

def test_traceback_standard_path():
    # WHY: Core use case. Simulates a standard diagonal path found by Smith-Waterman 
    # and ensures the indices map correctly back to the 0-indexed original sequences.
    H = np.zeros((4, 4))
    H[1, 1] = 1
    H[2, 2] = 2
    H[3, 3] = 3
    
    start_a, end_a, start_b, end_b = traceback(H)
    
    assert end_a == 2 and end_b == 2
    assert start_a == 0 and start_b == 0

def test_perform_alignment_integration(sample_chroma):
    # WHY: Core use case. Integration test to ensure all three modules (similarity, SW, traceback) 
    # communicate correctly to align two identical sequences from start to finish.
    chroma_a, chroma_b = sample_chroma
    start_a, end_a, start_b, end_b = perform_alignment(chroma_a, chroma_b)
    
    assert start_a == 0 and start_b == 0
    assert end_a == 4 and end_b == 4

def test_rectangular_matrices():
    # WHY: Verifies that the algorithm correctly handles clips of different lengths.
    # Swapping indices (T_a vs T_b) is a common bug that only appears in non-square matrices.
    chroma_a = np.random.rand(12, 100) # Long clip
    chroma_b = np.random.rand(12, 20)  # Short clip
    
    # Should not raise IndexError
    S = compute_similarity_matrix(chroma_a, chroma_b)
    H = smith_waterman(S)
    
    assert S.shape == (100, 20)
    assert H.shape == (101, 21)

def test_integration_partial_overlap():
    # WHY: Crucial real-world use case. Simulates when Clip B is a shorter snippet 
    # found exactly in the middle of Clip A (e.g., a phone recording during a longer master track).
    shared_audio = np.array([[1, 0, 1], [0, 1, 0]]) # Length 3
    noise = np.array([[0, 0], [0, 0]]) # Length 2
    
    # Clip A has noise, then the audio. Clip B is just the audio.
    chroma_a = np.hstack((noise, shared_audio)) # Length 5, starts at index 2
    chroma_b = shared_audio # Length 3, starts at index 0
    
    start_a, end_a, start_b, end_b = perform_alignment(chroma_a, chroma_b, match_score_bias=0.1)
    
    assert start_a == 2 and end_a == 4
    assert start_b == 0 and end_b == 2

# ==========================================
# EDGE CASES (Unusual but valid inputs)
# ==========================================

def test_smith_waterman_no_match():
    # WHY: Edge case. Tests algorithm behavior when two audio files share zero similarities. 
    # The bias should suppress all scores to 0, preventing false positive paths.
    S = np.zeros((3, 3))
    H = smith_waterman(S, match_score_bias=0.5)
    
    assert np.all(H == 0)

def test_traceback_short_path():
    # WHY: Edge case. Tests a scenario where only a single frame matches. 
    # Ensures the while-loop breaks immediately without indexing out of bounds.
    H = np.zeros((3, 3))
    H[1, 2] = 5.0 # Max at i=1, j=2
    
    start_a, end_a, start_b, end_b = traceback(H)
    
    assert end_a == 0 and end_b == 1
    assert start_a == 0 and start_b == 1

def test_traceback_zero_matrix():
    # WHY: Edge case. If there is absolutely no match, H is all zeros. 
    # argmax will return (0,0). Tests that the algorithm returns standard -1 indices 
    # rather than crashing.
    H = np.zeros((3, 3))
    start_a, end_a, start_b, end_b = traceback(H)
    
    assert start_a == -1 and start_b == -1
    assert end_a == -1 and end_b == -1

# ==========================================
# NEGATIVE TESTS (Failure Modes & Incorrect Inputs)
# ==========================================

def test_empty_chroma_input():
    # WHY: Failure mode. Corrupted audio might result in a 0-length sequence.
    # scikit-learn's cosine_similarity should catch this and raise a ValueError.
    chroma_a = np.empty((12, 0))
    chroma_b = np.empty((12, 0))
    
    # Updated to match the specific sklearn pairwise validation error
    with pytest.raises(ValueError, match="0 sample"):
        perform_alignment(chroma_a, chroma_b)

def test_dimension_mismatch():
    # WHY: Failure mode. Tests if one audio file was processed with 12 pitch bins 
    # and the other with 20. Matrix multiplication in cosine_similarity must reject this.
    chroma_a = np.random.rand(12, 100)
    chroma_b = np.random.rand(20, 100) # Wrong dimension
    
    with pytest.raises(ValueError, match="Incompatible dimension"):
        perform_alignment(chroma_a, chroma_b)

def test_nan_values_in_chroma():
    # WHY: Failure mode. If librosa extraction fails on corrupted audio bits, it creates NaNs.
    # The algorithm must raise an error rather than silently failing or infinitely looping.
    chroma_a = np.random.rand(12, 100)
    chroma_b = np.random.rand(12, 100)
    chroma_a[0, 50] = np.nan
    
    with pytest.raises(ValueError, match="Input contains NaN"):
        perform_alignment(chroma_a, chroma_b)

def test_smith_waterman_empty_input():
    # WHY: Ensures the SW function handles empty similarity matrices gracefully
    # by returning a 1x1 zero matrix rather than crashing.
    S = np.empty((0, 0))
    H = smith_waterman(S)
    assert H.shape == (1, 1)
    assert H[0, 0] == 0