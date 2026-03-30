"""
Chroma + Smith–Waterman-style local alignment (A5-compatible).

Used by ``ebs_segment.auto_align`` when ``EBS_AUTO_ALIGN_MODE=chroma_sw`` (default).
Cosine similarity is computed with NumPy only (no scikit-learn dependency).
"""

from __future__ import annotations

import numpy as np


def compute_similarity_matrix(chroma_a: np.ndarray, chroma_b: np.ndarray) -> np.ndarray:
    """
    Cosine similarity between each time frame of A vs each frame of B.

    Args:
        chroma_a: shape (12, T_a)
        chroma_b: shape (12, T_b)

    Returns:
        S of shape (T_a, T_b)
    """
    a = chroma_a.T.astype(np.float64, copy=False)
    b = chroma_b.T.astype(np.float64, copy=False)
    a_norm = a / (np.linalg.norm(a, axis=1, keepdims=True) + 1e-9)
    b_norm = b / (np.linalg.norm(b, axis=1, keepdims=True) + 1e-9)
    return (a_norm @ b_norm.T).astype(np.float32)


def smith_waterman(S: np.ndarray, match_score_bias: float = 0.5) -> np.ndarray:
    """Diagonal-only cumulative scoring (same structure as A5 ``alignment_core``)."""
    t_a, t_b = S.shape
    h = np.zeros((t_a + 1, t_b + 1), dtype=np.float32)
    m = S - match_score_bias

    if t_a <= t_b:
        for i in range(1, t_a + 1):
            h[i, 1:] = np.maximum(0, h[i - 1, :-1] + m[i - 1, :])
    else:
        for j in range(1, t_b + 1):
            h[1:, j] = np.maximum(0, h[:-1, j - 1] + m[:, j - 1])

    return h


def traceback(h: np.ndarray) -> tuple[int, int, int, int]:
    """Greedy diagonal traceback from max score (A5-compatible)."""
    i, j = np.unravel_index(np.argmax(h), h.shape)
    end_a, end_b = i - 1, j - 1

    while i > 0 and j > 0 and h[i, j] > 0:
        if h[i - 1, j - 1] == 0:
            break
        i -= 1
        j -= 1

    start_a, start_b = i - 1, j - 1
    return start_a, end_a, start_b, end_b


def perform_alignment(
    chroma_a: np.ndarray,
    chroma_b: np.ndarray,
    match_score_bias: float = 0.5,
) -> tuple[int, int, int, int]:
    """Return chroma frame indices (start_a, end_a, start_b, end_b)."""
    s = compute_similarity_matrix(chroma_a, chroma_b)
    h = smith_waterman(s, match_score_bias=match_score_bias)
    return traceback(h)
