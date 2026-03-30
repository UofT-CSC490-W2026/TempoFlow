import os
import json
import pytest
import numpy as np
import tempfile
from concurrent.futures import ProcessPoolExecutor, ThreadPoolExecutor, as_completed
import librosa
from tqdm import tqdm

# Import core validation logic
from src.alignment_and_segmentation.alignment_core import perform_alignment
from src.alignment_and_segmentation.utils import load_audio_files, check_audio_not_silent, extract_chroma

# Try to import boto3 for S3 access
try:
    import boto3
except ImportError:
    boto3 = None

# Constants for validation (User requirements)
MAX_ALIGNMENT_ERROR = 1.0 / 60.0  # ~0.017s (1 fps)
MIN_ALIGNMENT_SUCCESS_RATE = 0.995
MAX_START_PRED_ERROR = 2.5
MAX_END_PRED_ERROR = 2.5

def get_s3_client():
    if not boto3:
        return None, None
        
    aws_access_key = os.getenv("AWS_ACCESS_KEY_ID")
    aws_secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
    bucket_name = os.getenv("S3_BUCKET_NAME")

    if not all([aws_access_key, aws_secret_key, bucket_name]):
        return None, None
        
    try:
        s3 = boto3.client(
            "s3",
            aws_access_key_id=aws_access_key,
            aws_secret_access_key=aws_secret_key
        )
        return s3, bucket_name
    except Exception:
        return None, None

def fetch_data():
    """
    Retrieve manifest and ensure audio files are available.
    Returns:
        manifest (list): The list of test cases
        file_map (dict): Map of filename -> local path
    """
    file_map = {}
    manifest = []
    
    # Check manual override via pytest option or environment variable
    # If specific S3 credentials exist, try S3 first
    s3, bucket = get_s3_client()
    
    if s3:
        print("Using S3 Data Source")
        # Download manifest to temp
        temp_dir = tempfile.mkdtemp(prefix="audio_alignment_test_")
        
        try:
            manifest_key = "manifest.json" # Assuming root of bucket
            local_manifest = os.path.join(temp_dir, "manifest.json")
            s3.download_file(bucket, manifest_key, local_manifest)
            
            with open(local_manifest, "r") as f:
                manifest = json.load(f)
            
            # Identify unique files to download
            files_to_download = set()
            for item in manifest:
                files_to_download.add(item["clip_1_path"])
                files_to_download.add(item["clip_2_path"])
                
            print(f"Downloading {len(files_to_download)} files from S3...")
            
            def download_one(fname):
                # Remove './' prefix if present for S3 key
                key = fname[2:] if fname.startswith("./") else fname
                local_path = os.path.join(temp_dir, os.path.basename(key))
                if not os.path.exists(local_path):
                    s3.download_file(bucket, key, local_path)
                return fname, local_path

            with ThreadPoolExecutor(max_workers=10) as executor:
                futures = [executor.submit(download_one, f) for f in files_to_download]
                for future in as_completed(futures):
                    original_name, local_path = future.result()
                    file_map[original_name] = local_path
            
            return manifest, file_map
            
        except Exception as e:
            print(f"S3 Download Error: {str(e)}")
            # Fall through to local check

    # Fallback: Check local folder
    override_dir = os.getenv("LOCAL_DATA_DIR")
    # Also check "data/" in current working dir
    candidate_dirs = []
    if override_dir: candidate_dirs.append(override_dir)
    candidate_dirs.append("data")
    
    for d in candidate_dirs:
        if os.path.exists(d) and os.path.isdir(d):
            manifest_path = os.path.join(d, "manifest.json")
            if os.path.exists(manifest_path):
                print(f"Using Local Data Source: {d}")
                with open(manifest_path, "r") as f:
                    manifest = json.load(f)
                
                for item in manifest:
                    p1 = item["clip_1_path"]
                    p2 = item["clip_2_path"]
                    
                    # Resolve relative to data dir
                    # Assume structure matches manifest relative paths if they are simple
                    # or flattened.
                    f1 = os.path.join(d, os.path.basename(p1))
                    f2 = os.path.join(d, os.path.basename(p2))
                    
                    if not os.path.exists(f1): continue # Or warn
                    if not os.path.exists(f2): continue
                    
                    file_map[p1] = f1
                    file_map[p2] = f2
                
                return manifest, file_map

    print("No data source found (S3 or Local). Skipping.")
    return [], {}

def calculate_errors(test_case: dict, pred: dict):
    """
    Compute error metrics between ground truth (test_case) and prediction (pred).
    """
    gt_start_a = test_case["clip_1_start_sec"]
    gt_start_b = test_case["clip_2_start_sec"]
    gt_end_a = test_case["clip_1_end_sec"] # Used for end error check
    gt_end_b = test_case["clip_2_end_sec"]

    pred_start_a = pred["start_time_a"]
    pred_end_a = pred["end_time_a"]
    pred_start_b = pred["start_time_b"]
    pred_end_b = pred["end_time_b"]

    error_start_a = gt_start_a - pred_start_a
    error_start_b = gt_start_b - pred_start_b
    relative_alignment_error = abs(error_start_a - error_start_b)
    
    # since allignment error checks allignment, we only need to check one of the start times for start error, and one of the end times for end error
    return {
        "alignment_error": relative_alignment_error,
        "start_error_a": abs(error_start_a),
        "end_error_a": abs(gt_end_a - pred_end_a),
    }

def run_single_test_logic(test_case, file_map):
    path_a = file_map.get(test_case["clip_1_path"])
    path_b = file_map.get(test_case["clip_2_path"])
    
    if not path_a or not path_b:
        return {"error": "File not found", "test_id": test_case["test_id"]}

    try:        
        # 1. Load Audio
        # Assuming utils handles paths correctly now (based on code inspection)
        y_a, y_b, sr = load_audio_files(path_a, path_b)
        
        # 2. Check Silence
        check_audio_not_silent(y_a)
        check_audio_not_silent(y_b)
        
        # 3. Extract Features
        chroma_a = extract_chroma(y_a, sr)
        chroma_b = extract_chroma(y_b, sr)
        
        # 4. Perform Alignment
        start_a, end_a, start_b, end_b = perform_alignment(chroma_a, chroma_b)
                
        # 5. Convert to Time
        start_time_a = librosa.frames_to_time(start_a, sr=sr)
        end_time_a = librosa.frames_to_time(end_a, sr=sr)
        start_time_b = librosa.frames_to_time(start_b, sr=sr)
        end_time_b = librosa.frames_to_time(end_b, sr=sr)
        
        # Calculate duration of the match (min duration)
        duration_a = end_time_a - start_time_a
        duration_b = end_time_b - start_time_b
        min_duration = min(duration_a, duration_b)
        
        result_payload = {
            "start_time_a": float(start_time_a),
            "end_time_a": float(start_time_a + min_duration),
            "start_time_b": float(start_time_b),
            "end_time_b": float(start_time_b + min_duration)
        }
        
        metrics = calculate_errors(test_case, result_payload)
        metrics["test_id"] = test_case["test_id"]
        
        return metrics

    except Exception as e:
        return {"error": str(e), "test_id": test_case["test_id"]}

def test_alignment_algorithm_accuracy():
    """
    Test algorithm accuracy against a dataset (S3 or local).
    """
    manifest, file_map = fetch_data()
    
    if not manifest:
        pytest.skip("No dataset found. Set AWS credentials or provide local data.")
        
    results = []
    
    # Run in parallel with a progress bar
    with ProcessPoolExecutor() as executor:
        future_to_test = {
            executor.submit(run_single_test_logic, case, file_map): case 
            for case in manifest
        }
        
        # Wrap as_completed with tqdm for the loading bar
        for future in tqdm(as_completed(future_to_test), total=len(manifest), desc="Evaluating audio alignments"):
            res = future.result()
            results.append(res)

    # --- Analysis & Aggregation ---
    failed_tests = []
    alignment_errors = []
    start_error = []
    end_error = []
    failure_reasons = [] # Array to collect all failures
    
    # Extract data from results (Fixing the empty array bug from original code)
    for r in results:
        t_id = r.get('test_id', 'unknown')
        if "error" in r:
            failed_tests.append(f"{t_id}: ERROR {r['error']}")
        else:
            if "alignment_error" in r:
                alignment_errors.append(r["alignment_error"])
            if "start_error_a" in r:
                start_error.append(r["start_error_a"])
            if "end_error_a" in r:
                end_error.append(r["end_error_a"])

    # Calculate averages safely
    avg_allignment_error = np.mean(alignment_errors) if alignment_errors else 0
    
    if len(alignment_errors) > 0:
        num_allignment_within_range = sum(1 for e in alignment_errors if e <= MAX_ALIGNMENT_ERROR)
        pct_within_range = num_allignment_within_range / len(alignment_errors)
    else:
        num_allignment_within_range = 0
        pct_within_range = 0.0

    avg_start_error_a = np.mean(start_error) if start_error else 0
    avg_end_error_a = np.mean(end_error) if end_error else 0

    # Collect threshold failures instead of failing immediately
    if avg_allignment_error > MAX_ALIGNMENT_ERROR:
        failure_reasons.append(f"Average alignment error {avg_allignment_error:.5f}s > limit {MAX_ALIGNMENT_ERROR:.5f}s")
    
    if len(alignment_errors) == 0:
        failure_reasons.append("No successful alignments were performed (all tests failed or returned no alignment data).")
    elif pct_within_range < MIN_ALIGNMENT_SUCCESS_RATE:
        failure_reasons.append(f"Percentage of alignments within error range {pct_within_range:.5f} < limit {MIN_ALIGNMENT_SUCCESS_RATE:.5f}")
    
    if avg_start_error_a > MAX_START_PRED_ERROR:
        failure_reasons.append(f"Avg start prediction error {avg_start_error_a:.5f}s > limit {MAX_START_PRED_ERROR:.5f}s")
    
    if avg_end_error_a > MAX_END_PRED_ERROR:
        failure_reasons.append(f"Avg end prediction error {avg_end_error_a:.5f}s > limit {MAX_END_PRED_ERROR:.5f}s")

    if failed_tests:
        msg = f"{len(failed_tests)} test cases failed validation:\n  " + "\n  ".join(failed_tests[:10])
        failure_reasons.append(msg)

    # --- Final Assertion ---
    # If our failure reasons list has anything in it, fail the test and print everything.
    if failure_reasons:
        final_error_msg = "Test failed due to multiple reasons:\n\n- " + "\n- ".join(failure_reasons)
        pytest.fail(final_error_msg)