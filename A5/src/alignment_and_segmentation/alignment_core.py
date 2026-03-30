import numpy as np
from sklearn.metrics.pairwise import cosine_similarity

def compute_similarity_matrix(chroma_a: np.ndarray, chroma_b: np.ndarray) -> np.ndarray:
    """
    Compute cosine similarity matrix between two chroma feature sequences.
    
    Args:
        chroma_a: Chroma features for audio A, shape (n_features, time_steps_a)
        chroma_b: Chroma features for audio B, shape (n_features, time_steps_b)
        
    Returns:
        Similarity matrix of shape (time_steps_a, time_steps_b)
    """
    # chroma shape is (12, T) — transpose to (T, 12) for pairwise comparison
    S = cosine_similarity(chroma_a.T, chroma_b.T)  
    return S

def smith_waterman(S: np.ndarray, match_score_bias: float = 0.5) -> np.ndarray:
    """
    Perform Smith-Waterman local alignment algorithm.
    
    Args:
        S: Similarity matrix
        match_score_bias: Bias to subtract from similarity scores
        
    Returns:
        H: Scoring matrix
    """
    T_a, T_b = S.shape
    H = np.zeros((T_a + 1, T_b + 1), dtype=np.float32)

    # Precompute the scoring matrix to avoid doing this in the loop
    M = S - match_score_bias

    # Vectorized implementation could be faster, but keeping iteratively for clarity/correctness
    # as SW has data dependencies. Numba could speed this up if needed.
    if T_a <= T_b:
        for i in range(1, T_a + 1):
            # Update entire row i at once based on row i-1
            H[i, 1:] = np.maximum(0, H[i-1, :-1] + M[i-1, :])
    else:
        for j in range(1, T_b + 1):
            # Update entire column j at once based on col j-1
            H[1:, j] = np.maximum(0, H[:-1, j-1] + M[:, j-1])
            
    return H

def traceback(H: np.ndarray) -> tuple[int, int, int, int]:
    """
    Traceback from the highest score in H to find the optimal local alignment.
    
    Returns:
        tuple: (start_index_a, end_index_a, start_index_b, end_index_b)
    """
    i, j = np.unravel_index(np.argmax(H), H.shape)
    end_a, end_b = i - 1, j - 1  # convert back to 0-indexed

    while i > 0 and j > 0 and H[i, j] > 0:
        # Simple traceback: diagonal move if possible
        # Since we only stored scores, we assume the path came from the max.
        # Strict SW usually stores pointers. Here we seemingly assume diagonal precedence
        # or simple greedy ascent if H[i-1, j-1] contributed to H[i,j].
        # Given the implementation: match = H[i-1, j-1] + ...
        # This traceback logic assumes the path solely consists of matches (diagonal moves).
        # Standard SW allows gaps (horizontal/vertical moves).
        # If the original code only supported diagonals, I will keep it consistent.
        if H[i-1, j-1] == 0:
            break
        i -= 1
        j -= 1

    start_a, start_b = i - 1, j - 1
    return start_a, end_a, start_b, end_b

def perform_alignment(chroma_a: np.ndarray, chroma_b: np.ndarray, match_score_bias: float = 0.5) -> tuple[int, int, int, int]:
    """
    Main function to compute alignment indices between two chroma sequences.
    """
    S = compute_similarity_matrix(chroma_a, chroma_b)
    H = smith_waterman(S, match_score_bias=match_score_bias)
    return traceback(H)
