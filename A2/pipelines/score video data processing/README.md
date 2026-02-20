# Dance similarity score Algorithm validation Data Generation Pipeline

Generate same level similarity score validation datasets by filtering, generating combinations, and sampling shorter clips if needed.
The current pipeline is for high similarity, same dance, different (>1) dancer, same angle (1.2k source videos after filtering, around 11s each). 
This ensures the scoring algorithm has similar performance for similar level of dance.

## Local
Optional 1: from scratch
1. download refined_2M_all_video_url.csv from https://aistdancedb.ongaaccel.jp/database_download/#compact-versions-each-line-contains-only-url, add url to the first line OR directly use the downloaded and processed csv in this folder.
2. run filter.py to generate filtered_comparison_list.csv. this should contain 1212 lines (1211 entries). To change the conditions, change the variables in the CONFIGURATION FLAGS section on the top of the file.
3. run download_AIST.py to download the dataset. (change DEST_FOLDER for specifying destination folder)
```bash
#option 1: from scratch
python filter.py
python download_AIST.py
```

Option 2: Use uploaded preprocessed csvs (this is specific to the outlined condition in the description)
1. Omitted, directly use the downloaded and processed csv in this folder.
2. run filter.py to generate filtered_comparison_list.csv. this should contain 1308 lines (1307 entries).
3. run download_AIST.py to download the dataset. (default is filtered_comparison_list.csv, change DEST_FOLDER for specifying destination folder)
```bash
#option 2: use existing preprocessed csv
python download_AIST.py
```

## Aws 3 Buckets
In progress

## Video ID Scheme
The naming follows the AIST naming scheme:
![alt text](https://aistdancedb.ongaaccel.jp/images/symbols/symbol_1.png "Naming Scheme")

## Downloaded Dataset Structure

Details can be found in the download_manifest.txt generated. (can be found directly in the folder too)

```
AIST_Dances/
├── gGENRE_SITUATION_MUSIC_CHOERO/
│   ├── gBR_sBM_c01_d04_mBR0_ch01.mp4
│   ├── gBR_sBM_c01_d05_mBR0_ch01.mp4
│   └── ...
└── test_cases.json
```

## Project Structure

```
├── requirements.txt
├── pipeline/
│   ├── filter.py                      # Filter for relevant data
│   ├── download_AIST.py               # Download filtered data
│   ├── download_manifest.txt          # Detailed folder structure of the 
│   │                                    1.2k dataset
│   ├── filtered_comparison_list.csv   # Filtered csv of the 1.2k dataset
│   └── refined_2M_all_video_url.csv   # Original csv of the AIST dataset

```

## Requirements

- Python 3.7+
- pandas
- tqdm
- requests
- Dependencies in `requirements.txt`
