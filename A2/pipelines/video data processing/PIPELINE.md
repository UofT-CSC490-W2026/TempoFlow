# Dancer Alignment Validation Pipeline

## High-Level Architecture

```mermaid
flowchart LR
    subgraph Generation["Data Generation"]
        A["AIST++ Dataset"] --> B["Apply Transformations"]
        B --> C["Upload to S3"]
    end
    
    subgraph Storage["AWS S3"]
        C --> D[("S3 Bucket")]
        D --> E["references/"]
        D --> F["transformed_videos/"]
        D --> G["test_cases.json"]
    end
    
    subgraph Validation["Model Validation"]
        D --> H["Stream via Presigned URLs"]
        H --> I["Scoring Model"]
        I --> J["Alignment Score"]
    end
    
    K["AWS Credentials"] -.-> C
    K -.-> H
```

## Pipeline Flow

| Step | Description |
|------|-------------|
| 1. Source | Random clips from AIST++ dance dataset |
| 2. Transform | Apply scale, rotation, translation, temporal offset |
| 3. Upload | Push to S3 (references + transformed videos + JSON) |
| 4. Validate | Stream videos, run model, compare scores to expected ranges |

## Video ID Scheme

Reference videos are assigned a sequential ID (`R001`, `R002`, …). Each transformed video's ID prepends its parent reference ID followed by a transform index (`R001_T001`, `R001_T002`, …), making the relationship between videos immediately clear.

| Example | Filename |
|---------|----------|
| Reference #1 | `R001_dance_reference.mp4` |
| Scale 0.8× | `R001_T001_dance_spatial_scale_0.8.mp4` |
| Rotation 10° | `R001_T002_dance_spatial_rotation_10.mp4` |

## Transformation Types

```mermaid
flowchart TD
    REF["Reference Clip"] --> SPATIAL["Spatial Transforms"]
    REF --> TEMPORAL["Temporal Transforms"]
    REF --> NEGATIVE["Negative Sampling"]
    
    SPATIAL --> SCALE["Scale 0.8x-1.2x"]
    SPATIAL --> ROTATE["Rotate ±15°"]
    SPATIAL --> TRANSLATE["Translate ±10%"]
    SPATIAL --> ASPECT["Aspect 0.9x-1.1x"]
    
    TEMPORAL --> OFFSET["Offset 0.1-0.5s"]
    
    NEGATIVE --> DISTINCT["Different Dance"]
```
