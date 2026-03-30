from fastapi import APIRouter, UploadFile, File, HTTPException
from src.alignment_and_segmentation.alignment_core import perform_alignment
from src.alignment_and_segmentation.segmentation_core import track_beats, estimate_downbeat_phase, generate_segments
from src.alignment_and_segmentation.utils import (
    check_less_than_one_minute, 
    load_audio_files, 
    check_audio_not_silent, 
    extract_chroma,
    map_segments_to_clips
)
from src.alignment_and_segmentation.schemas import AlignmentResult, TimeRange, Segment, AlignmentAndSegmentationResult
import librosa

router = APIRouter()

ALLOWED_VIDEO_TYPES = {
    "video/mp4",
    "video/quicktime",     # .mov
    "video/x-matroska",    # .mkv
    "video/x-msvideo",     # .avi
    "video/webm",
}

def validate_video_file(file: UploadFile) -> None:
    if file.content_type not in ALLOWED_VIDEO_TYPES:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{file.content_type}'. Must be a video file."
        )

@router.post("/api/process", response_model=AlignmentAndSegmentationResult)
async def align_audio(
    file_a: UploadFile = File(...),
    file_b: UploadFile = File(...)
) -> AlignmentAndSegmentationResult:
    """
    Align two audio/video files based on their audio tracks and segment the aligned portion.
    Returns alignment time ranges and segmentation timestamps.
    """
    validate_video_file(file_a)
    validate_video_file(file_b)

    # Load audio
    try:
        y_a, y_b, sr = load_audio_files(file_a, file_b)
    except Exception as e:
        raise HTTPException(status_code=422, detail=f"Error processing audio files: {str(e)}")

    try:
        check_less_than_one_minute(y_a, sr)
        check_less_than_one_minute(y_b, sr)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    # Check silence
    try:
        check_audio_not_silent(y_a)
        check_audio_not_silent(y_b)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))

    # Extract features
    chroma_a = extract_chroma(y_a, sr)
    chroma_b = extract_chroma(y_b, sr)

    # Perform alignment
    # start/end are frame indices
    start_a, end_a, start_b, end_b = perform_alignment(chroma_a, chroma_b)

    # Convert frames to time
    start_time_a = librosa.frames_to_time(start_a, sr=sr)
    end_time_a = librosa.frames_to_time(end_a, sr=sr)
    start_time_b = librosa.frames_to_time(start_b, sr=sr)
    end_time_b = librosa.frames_to_time(end_b, sr=sr)
    
    # Calculate duration of the match
    duration_a = end_time_a - start_time_a
    duration_b = end_time_b - start_time_b
    min_duration = min(duration_a, duration_b)

    # Segmentation Logic
    # 1. Extract aligned part of audio A
    # Chroma hop_length default is 512
    hop_length = 512
    sample_start_a = librosa.frames_to_samples(start_a, hop_length=hop_length)
    sample_end_a = librosa.frames_to_samples(end_a, hop_length=hop_length)
    
    # Ensure indices are within bounds
    sample_start_a = max(0, sample_start_a)
    sample_end_a = min(len(y_a), sample_end_a)
    
    y_aligned_a = y_a[sample_start_a:sample_end_a]

    # 2. Track beats
    try:
        beat_times, bpm, confidence_info, onset_env, beat_frames = track_beats(y_aligned_a, sr)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Beat tracking failed: {str(e)}")

    # 3. Check Confidence
    # Adjust threshold as needed. CV > 1.0 is usually very poor rhythm.
    if confidence_info["coefficient_of_variation"] > 1.0:
        raise HTTPException(
            status_code=422, 
            detail=f"Rhythm too irregular for segmentation (CV={confidence_info['coefficient_of_variation']})"
        )

    # 4. Estimate Downbeat Phase and Generate Segments (Points)
    beats_per_seg = 8
    try:
        downbeat_offset = estimate_downbeat_phase(onset_env, beat_frames, beats_per_seg)
        segment_points, segment_beat_times = generate_segments(beat_times, downbeat_offset, beats_per_seg)
    except ValueError as e:
         raise HTTPException(status_code=422, detail=f"Segmentation failed: {str(e)}")

    # 5. Map segments to File A and File B
    # Segment points are relative to the start of the aligned region (Time 0 of y_aligned_a)
    
    # Map for File A
    # aligned region for A is [start_time_a, end_time_a]
    segs_a_tuples = map_segments_to_clips(segment_points, start_time_a, end_time_a, segment_beat_times)
    
    # Map for File B
    # aligned region for B is [start_time_b, end_time_b]
    # We assume the time scaling is roughly 1:1 or the best approximation is linear offset 
    # since we are using the beats derived from A.
    segs_b_tuples = map_segments_to_clips(segment_points, start_time_b, end_time_b, segment_beat_times)

    # Convert to Pydantic models
    clip_a_segments_out = [
        Segment(start_time=s, end_time=e, beat_times=bt) for s, e, bt in segs_a_tuples
    ]
    clip_b_segments_out = [
        Segment(start_time=s, end_time=e, beat_times=bt) for s, e, bt in segs_b_tuples
    ]

    # Return combined result
    return AlignmentAndSegmentationResult(
        alignment=AlignmentResult(
            file_a=TimeRange(
                start_time=float(start_time_a),
                end_time=float(start_time_a + min_duration)
            ),
            file_b=TimeRange(
                start_time=float(start_time_b),
                end_time=float(start_time_b + min_duration)
            )
        ),
        clip_a_segments=clip_a_segments_out,
        clip_b_segments=clip_b_segments_out,
        confidence=confidence_info
    )
