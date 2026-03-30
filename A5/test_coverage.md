# A5 Test Coverage Report

*Last Updated: Mon Mar 30 21:47:53 UTC 2026*

```text
============================= test session starts ==============================
platform linux -- Python 3.12.13, pytest-9.0.2, pluggy-1.6.0
rootdir: /home/runner/work/TempoFlow/TempoFlow/A5
plugins: cov-7.1.0, anyio-4.13.0
collected 292 items

tests/alignment_and_segmentation/test_alignment_algo_accuracy.py s       [  0%]
tests/alignment_and_segmentation/test_alignment_core.py ................ [  5%]
                                                                         [  5%]
tests/alignment_and_segmentation/test_router.py .........                [  8%]
tests/alignment_and_segmentation/test_segmentation_core.py ............. [ 13%]
.                                                                        [ 13%]
tests/alignment_and_segmentation/test_utils.py ..................        [ 19%]
tests/eval/test_config.py .                                              [ 20%]
tests/eval/test_dashboard.py ....                                        [ 21%]
tests/eval/test_review_ui.py ..............                              [ 26%]
tests/eval/test_runner.py .................                              [ 32%]
tests/eval/test_storage.py .................................             [ 43%]
tests/test_ebs_web_adapter.py .....................                      [ 50%]
tests/test_ffmpeg_paths.py ..............                                [ 55%]
tests/test_gemini_move_feedback.py .................................     [ 66%]
tests/test_main.py ................................                      [ 77%]
tests/test_overlay_api.py .............................................. [ 93%]
.....                                                                    [ 95%]
tests/test_visualization.py ..............Creating new Ultralytics Settings v0.0.6 file ✅ 
View Ultralytics Settings with 'yolo settings' or at '/home/runner/.config/Ultralytics/settings.json'
Update Settings with 'yolo settings key=value', i.e. 'yolo settings runs_dir=path/to/dir'. For help see https://docs.ultralytics.com/quickstart/#ultralytics-settings.
                               [100%]

================================ tests coverage ================================
_______________ coverage: platform linux, python 3.12.13-final-0 _______________

Name                                                  Stmts   Miss  Cover
-------------------------------------------------------------------------
src/__init__.py                                           0      0   100%
src/alignment_and_segmentation/__init__.py                1      0   100%
src/alignment_and_segmentation/alignment_core.py         29      0   100%
src/alignment_and_segmentation/router.py                 62      0   100%
src/alignment_and_segmentation/schemas.py                17      0   100%
src/alignment_and_segmentation/segmentation_core.py      59      0   100%
src/alignment_and_segmentation/utils.py                  58      0   100%
src/ebs_web_adapter.py                                  221      0   100%
src/eval/__init__.py                                      6      0   100%
src/eval/config.py                                       10      0   100%
src/eval/dashboard.py                                    26      0   100%
src/eval/review_ui.py                                    76      0   100%
src/eval/runner.py                                      139      0   100%
src/eval/storage.py                                     191      0   100%
src/eval/visualization.py                               128     22    83%
src/ffmpeg_paths.py                                      65      2    97%
src/gemini_move_feedback.py                             361     62    83%
src/main.py                                             205     14    93%
src/overlay_api.py                                     1130    240    79%
-------------------------------------------------------------------------
TOTAL                                                  2784    340    88%
======================= 291 passed, 1 skipped in 44.56s ========================
```
