"""
Dancer Alignment Validation Data Generation Pipeline

CLI entry point for generating validation datasets by applying
mathematical affine transformations to reference dance videos.

Usage:
    python main.py generate --input ./videos --output ./processed
    python main.py generate --input ./videos --to-s3
    python main.py stream
"""

import click
import os
import sys
import random
from pathlib import Path
from tqdm import tqdm

from pipeline.video_utils import (
    read_video_frames, write_video_frames, encode_video_to_bytes,
    find_high_motion_clip, get_video_info
)
from pipeline.transformations import (
    apply_scale, apply_rotation, apply_translation, 
    apply_aspect_ratio, apply_combined, generate_random_transform_params
)
from pipeline.temporal import apply_temporal_offset, calculate_expected_score_for_offset
from pipeline.negative_sampling import select_distinct_clip, get_video_files, get_expected_score_for_negative
from pipeline.ground_truth import create_test_case, export_ground_truth, get_expected_score_range

from aws.credentials import prompt_credentials, validate_all, get_s3_client
from aws.s3_upload import upload_file, upload_video_bytes, generate_s3_key
from aws.s3_stream import (
    generate_presigned_url, stream_video_frames, 
    list_videos_in_bucket, get_video_pairs_for_validation
)

from model.runner import run_model


@click.group()
def cli():
    """Dancer Alignment Validation Data Generation Pipeline."""
    pass


@cli.command()
@click.option('--input', 'input_dir', default='./input', 
              help='Input directory containing source videos (default: ./input)')
@click.option('--output', 'output_dir', default='./output',
              help='Output directory for processed videos (default: ./output)')
@click.option('--to-s3', 'to_s3', is_flag=True, default=False,
              help='Upload to S3 instead of saving locally (ignores --output)')
def generate(input_dir: str, output_dir: str, to_s3: bool):
    """
    Generate validation dataset by applying transformations to source videos.
    
    Applies various transformations (scale, rotation, translation, aspect ratio,
    temporal offset) and generates ground truth JSON with expected scores.
    """
    input_path = Path(input_dir)
    
    # Validate input directory
    if not input_path.exists():
        click.echo(f"Error: Input directory does not exist: {input_dir}", err=True)
        sys.exit(1)
    
    video_files = get_video_files(str(input_path))
    if not video_files:
        click.echo(f"Error: No video files found in: {input_dir}", err=True)
        sys.exit(1)
    
    click.echo(f"Found {len(video_files)} video(s) in {input_dir}")
    
    # AWS setup if uploading to S3
    s3_client = None
    bucket_name = None
    
    if to_s3:
        click.echo("\nS3 upload mode enabled. Videos will be uploaded directly to S3.")
        click.echo("Output directory will be ignored.\n")
        
        access_key, secret_key, region, bucket_name = prompt_credentials()
        
        # Validate credentials before processing
        click.echo("\nValidating AWS credentials...")
        is_valid, message = validate_all(access_key, secret_key, region, bucket_name)
        
        if not is_valid:
            click.echo(f"\n✗ {message}", err=True)
            click.echo("Aborting. Please check your credentials and try again.", err=True)
            sys.exit(1)
        
        click.echo(f"\n✓ {message}")
        s3_client = get_s3_client(access_key, secret_key, region)
    else:
        # Create output directory for local saves
        output_path = Path(output_dir)
        output_path.mkdir(parents=True, exist_ok=True)
        (output_path / 'references').mkdir(exist_ok=True)
        (output_path / 'transformed_videos').mkdir(exist_ok=True)
        click.echo(f"Output directory: {output_dir}")
    
    test_cases = []
    ref_counter = 0
    
    # Process each video
    for video_path in tqdm(video_files, desc="Processing videos"):
        video_name = Path(video_path).stem
        ref_counter += 1
        ref_id = f"R{ref_counter:03d}"
        transform_counter = 0
        
        click.echo(f"\n--- Processing: {video_name} (ID: {ref_id}) ---")
        
        try:
            # Find a high-motion clip (3-5 seconds)
            result = find_high_motion_clip(video_path, 3.0, 5.0)
            if result is None:
                click.echo(f"  Skipping: Could not extract high-motion clip")
                continue
            
            ref_frames, fps = result
            click.echo(f"  Extracted {len(ref_frames)} frames at {fps:.1f} fps")
            
            # Save/upload reference
            ref_filename = f"{ref_id}_{video_name}_reference.mp4"
            if to_s3:
                ref_bytes = encode_video_to_bytes(ref_frames, fps)
                ref_key = generate_s3_key("references", ref_filename)
                upload_video_bytes(s3_client, ref_bytes, bucket_name, ref_key)
            else:
                ref_path = output_path / 'references' / ref_filename
                write_video_frames(ref_frames, str(ref_path), fps)
                ref_key = f"references/{ref_filename}"
            
            # Generate transformed versions
            transformations = [
                # Spatial: Scale variations
                ("spatial_scale", 0.8),
                ("spatial_scale", 1.2),
                
                # Spatial: Rotation variations
                ("spatial_rotation", 10),
                ("spatial_rotation", -10),
                
                # Spatial: Translation variations
                ("spatial_translation_x", 0.08),
                ("spatial_translation_y", 0.08),
                
                # Morphological: Aspect ratio variations
                ("morphological_aspect", 0.9),
                ("morphological_aspect", 1.1),
                
                # Temporal: Offset variations
                ("temporal_offset", 0.2),
                ("temporal_offset", 0.4),
            ]
            
            for transform_type, param_value in transformations:
                transform_counter += 1
                transform_id = f"{ref_id}_T{transform_counter:03d}"
                transformed_video_filename = f"{transform_id}_{video_name}_{transform_type}_{param_value}.mp4"
                
                # Apply transformation
                if transform_type == "spatial_scale":
                    transformed_video_frames = apply_scale(ref_frames, param_value)
                elif transform_type == "spatial_rotation":
                    transformed_video_frames, _ = apply_rotation(ref_frames, param_value)
                elif transform_type == "spatial_translation_x":
                    transformed_video_frames, _ = apply_translation(ref_frames, param_value, 0)
                elif transform_type == "spatial_translation_y":
                    transformed_video_frames, _ = apply_translation(ref_frames, 0, param_value)
                elif transform_type == "morphological_aspect":
                    transformed_video_frames = apply_aspect_ratio(ref_frames, param_value)
                elif transform_type == "temporal_offset":
                    transformed_video_frames, _ = apply_temporal_offset(ref_frames, param_value, fps)
                else:
                    continue
                
                # Save/upload transformed video
                if to_s3:
                    transformed_video_bytes = encode_video_to_bytes(transformed_video_frames, fps)
                    transformed_video_key = generate_s3_key("transformed_videos", transformed_video_filename, transform_type)
                    upload_video_bytes(s3_client, transformed_video_bytes, bucket_name, transformed_video_key)
                else:
                    transformed_video_path = output_path / 'transformed_videos' / transformed_video_filename
                    write_video_frames(transformed_video_frames, str(transformed_video_path), fps)
                    transformed_video_key = f"transformed_videos/{transformed_video_filename}"
                
                # Create test case
                expected_range = get_expected_score_range(transform_type, param_value)
                test_case = create_test_case(
                    test_id=f"{transform_id}_{video_name}_{transform_type}_{param_value}",
                    ref_key=ref_key,
                    transformed_video_key=transformed_video_key,
                    transformation_type=transform_type,
                    param_value=param_value,
                    expected_score_range=expected_range
                )
                test_cases.append(test_case)
            
            # Combined transformation
            combined_params = {
                "scale": random.uniform(0.9, 1.1),
                "rotation": random.uniform(-10, 10),
                "translation": (random.uniform(-0.05, 0.05), random.uniform(-0.05, 0.05)),
                "aspect_ratio": random.uniform(0.95, 1.05)
            }
            
            transformed_video_frames, actual_params = apply_combined(
                ref_frames,
                scale=combined_params["scale"],
                rotation=combined_params["rotation"],
                translation=combined_params["translation"],
                aspect_ratio=combined_params["aspect_ratio"]
            )
            
            transform_counter += 1
            transform_id = f"{ref_id}_T{transform_counter:03d}"
            combined_filename = f"{transform_id}_{video_name}_combined.mp4"
            if to_s3:
                transformed_video_bytes = encode_video_to_bytes(transformed_video_frames, fps)
                transformed_video_key = generate_s3_key("transformed_videos", combined_filename, "combined")
                upload_video_bytes(s3_client, transformed_video_bytes, bucket_name, transformed_video_key)
            else:
                transformed_video_path = output_path / 'transformed_videos' / combined_filename
                write_video_frames(transformed_video_frames, str(transformed_video_path), fps)
                transformed_video_key = f"transformed_videos/{combined_filename}"
            
            test_case = create_test_case(
                test_id=f"{transform_id}_{video_name}_combined",
                ref_key=ref_key,
                transformed_video_key=transformed_video_key,
                transformation_type="combined",
                param_value=0,
                expected_score_range=get_expected_score_range("combined"),
                metadata={"actual_params": actual_params}
            )
            test_cases.append(test_case)
            
            # Negative sampling (if multiple videos available)
            if len(video_files) > 1:
                negative_result = select_distinct_clip(str(input_path), video_path)
                if negative_result:
                    neg_frames, neg_source, neg_fps = negative_result
                    
                    transform_counter += 1
                    transform_id = f"{ref_id}_T{transform_counter:03d}"
                    neg_filename = f"{transform_id}_{video_name}_negative.mp4"
                    if to_s3:
                        neg_bytes = encode_video_to_bytes(neg_frames, neg_fps)
                        neg_key = generate_s3_key("transformed_videos", neg_filename, "negative")
                        upload_video_bytes(s3_client, neg_bytes, bucket_name, neg_key)
                    else:
                        neg_path = output_path / 'transformed_videos' / neg_filename
                        write_video_frames(neg_frames, str(neg_path), neg_fps)
                        neg_key = f"transformed_videos/{neg_filename}"
                    
                    test_case = create_test_case(
                        test_id=f"{transform_id}_{video_name}_negative",
                        ref_key=ref_key,
                        transformed_video_key=neg_key,
                        transformation_type="negative",
                        param_value=0,
                        expected_score_range=get_expected_score_for_negative(),
                        metadata={"negative_source": Path(neg_source).name}
                    )
                    test_cases.append(test_case)
            
            click.echo(f"  Generated {len([t for t in test_cases if video_name in t['test_id']])} test cases")
            
        except Exception as e:
            click.echo(f"  Error processing {video_name}: {e}", err=True)
            continue
    
    # Export ground truth
    if to_s3:
        # Upload JSON to S3
        import json
        import tempfile
        
        with tempfile.NamedTemporaryFile(mode='w', suffix='.json', delete=False) as f:
            json.dump({"test_cases": test_cases, "total_count": len(test_cases)}, f, indent=2)
            temp_path = f.name
        
        upload_file(s3_client, temp_path, bucket_name, "test_cases.json")
        os.remove(temp_path)
        click.echo(f"\n✓ Uploaded test_cases.json to s3://{bucket_name}/test_cases.json")
    else:
        gt_path = output_path / 'test_cases.json'
        export_ground_truth(test_cases, str(gt_path))
        click.echo(f"\n✓ Exported {len(test_cases)} test cases to {gt_path}")
    
    click.echo("\n" + "=" * 50)
    click.echo("Generation complete!")
    click.echo(f"Total test cases: {len(test_cases)}")
    click.echo("=" * 50)


@cli.command()
def stream():
    """
    Stream videos from S3 and run the alignment model.
    
    Prompts for AWS credentials, lists available video pairs,
    and runs the model (when implemented).
    """
    click.echo("=" * 50)
    click.echo("S3 Video Streaming Mode")
    click.echo("=" * 50)
    
    # Get AWS credentials
    access_key, secret_key, region, bucket_name = prompt_credentials()
    
    # Validate credentials
    click.echo("\nValidating AWS credentials...")
    is_valid, message = validate_all(access_key, secret_key, region, bucket_name)
    
    if not is_valid:
        click.echo(f"\n✗ {message}", err=True)
        sys.exit(1)
    
    click.echo(f"✓ {message}")
    
    s3_client = get_s3_client(access_key, secret_key, region)
    
    # List available videos
    click.echo("\nScanning bucket for video pairs...")
    pairs = get_video_pairs_for_validation(s3_client, bucket_name)
    
    if not pairs:
        click.echo("No video pairs found. Make sure you've run 'generate --to-s3' first.")
        sys.exit(1)
    
    click.echo(f"Found {len(pairs)} video pair(s)")
    
    # Process each pair
    for ref_key, transformed_video_key in tqdm(pairs, desc="Processing pairs"):
        click.echo(f"\nReference: {ref_key}")
        click.echo(f"Transformed video: {transformed_video_key}")
        
        try:
            # Generate presigned URLs
            ref_url = generate_presigned_url(s3_client, bucket_name, ref_key)
            transformed_video_url = generate_presigned_url(s3_client, bucket_name, transformed_video_key)
            
            # TODO: Run the model when implemented
            click.echo("  Running model...")
            try:
                score = run_model(ref_url, transformed_video_url)
                click.echo(f"  Score: {score:.2%}")
            except NotImplementedError:
                click.echo("  [Model not yet implemented - skipping scoring]")
                
        except Exception as e:
            click.echo(f"  Error: {e}", err=True)
            continue
    
    click.echo("\n" + "=" * 50)
    click.echo("Streaming complete!")
    click.echo("=" * 50)


if __name__ == "__main__":
    cli()
