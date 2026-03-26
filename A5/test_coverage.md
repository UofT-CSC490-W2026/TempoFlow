# A5 Test Coverage Report

*Last Updated: Thu Mar 26 23:33:10 UTC 2026*

```text
============================= test session starts ==============================
platform linux -- Python 3.12.13, pytest-9.0.2, pluggy-1.6.0
rootdir: /home/runner/work/TempoFlow/TempoFlow/A5
plugins: anyio-4.13.0, cov-7.1.0
collected 172 items

tests/alignment_and_segmentation/test_alignment_algo_accuracy.py s       [  0%]
tests/alignment_and_segmentation/test_alignment_core.py ................ [  9%]
                                                                         [  9%]
tests/alignment_and_segmentation/test_router.py .........                [ 15%]
tests/alignment_and_segmentation/test_segmentation_core.py ............. [ 22%]
.                                                                        [ 23%]
tests/alignment_and_segmentation/test_utils.py ..................        [ 33%]
tests/test_ebs_web_adapter.py .....................                      [ 45%]
tests/test_ffmpeg_paths.py ..............                                [ 54%]
tests/test_gemini_move_feedback.py ..........................            [ 69%]
tests/test_main.py ................................                      [ 87%]
tests/test_overlay_api.py .....................                          [100%]

================================ tests coverage ================================
_______________ coverage: platform linux, python 3.12.13-final-0 _______________

Name                                                  Stmts   Miss  Cover
-------------------------------------------------------------------------
src/__init__.py                                           0      0   100%
src/alignment_and_segmentation/__init__.py                4      0   100%
src/alignment_and_segmentation/alignment_core.py         29      0   100%
src/alignment_and_segmentation/router.py                 62      0   100%
src/alignment_and_segmentation/schemas.py                17      0   100%
src/alignment_and_segmentation/segmentation_core.py      59      0   100%
src/alignment_and_segmentation/utils.py                  58      0   100%
src/ebs_web_adapter.py                                  213      0   100%
src/ffmpeg_paths.py                                      57      0   100%
src/gemini_move_feedback.py                             192      0   100%
src/main.py                                             153      0   100%
src/overlay_api.py                                      474    297    37%
-------------------------------------------------------------------------
TOTAL                                                  1318    297    77%
======================= 171 passed, 1 skipped in 37.86s ========================
```
