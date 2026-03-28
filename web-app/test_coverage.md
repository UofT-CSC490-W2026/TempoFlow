# Web App Test Coverage Report

*Last Updated: Sat Mar 28 00:46:30 UTC 2026*

```text

> web-app@0.1.0 coverage
> vitest run --coverage


[1m[46m RUN [49m[22m [36mv4.1.2 [39m[90m/home/runner/work/TempoFlow/TempoFlow/web-app[39m
      [2mCoverage enabled with [22m[33mv8[39m

 [32m✓[39m src/lib/analysis.test.ts [2m([22m[2m11 tests[22m[2m)[22m[32m 26[2mms[22m[39m
 [32m✓[39m src/lib/ebsTemporalLlm.test.ts [2m([22m[2m27 tests[22m[2m)[22m[32m 29[2mms[22m[39m
 [32m✓[39m src/lib/bodyPix/compare.integration.test.ts [2m([22m[2m19 tests[22m[2m)[22m[32m 160[2mms[22m[39m
 [32m✓[39m src/lib/bodyPix/pure.test.ts [2m([22m[2m30 tests[22m[2m)[22m[32m 22[2mms[22m[39m
 [32m✓[39m src/components/ebs/FeedbackViewer.test.tsx [2m([22m[2m9 tests[22m[2m)[22m[32m 180[2mms[22m[39m
 [32m✓[39m src/lib/yoloOverlayGenerator.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 185[2mms[22m[39m
 [32m✓[39m src/lib/fastSamOverlayGenerator.test.ts [2m([22m[2m9 tests[22m[2m)[22m[33m 1593[2mms[22m[39m
     [33m[2m✓[22m[39m generates frames at 30 FPS for the full duration [33m 338[2mms[22m[39m
     [33m[2m✓[22m[39m generates frames at 30 FPS for the full duration [33m 321[2mms[22m[39m
 [32m✓[39m src/lib/movenetOverlayGenerator.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 260[2mms[22m[39m
 [32m✓[39m src/app/dashboard/page.test.tsx [2m([22m[2m3 tests[22m[2m)[22m[32m 128[2mms[22m[39m
 [32m✓[39m src/components/ebs/useEbsViewer.test.ts [2m([22m[2m7 tests[22m[2m)[22m[32m 61[2mms[22m[39m
 [32m✓[39m src/app/api/coach/route.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 40[2mms[22m[39m
 [32m✓[39m src/app/api/sam3/video/route.test.ts [2m([22m[2m6 tests[22m[2m)[22m[33m 1190[2mms[22m[39m
     [33m[2m✓[22m[39m returns 400 if video exceeds MAX_VIDEO_MB [33m 928[2mms[22m[39m
 [32m✓[39m src/lib/poseAnalysis.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 170[2mms[22m[39m
 [32m✓[39m src/app/api/sam3/frame/route.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 28[2mms[22m[39m
 [32m✓[39m src/lib/sessionStorage.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 23[2mms[22m[39m
 [32m✓[39m src/components/RoboflowVideoOverlay.test.tsx [2m([22m[2m4 tests[22m[2m)[22m[32m 69[2mms[22m[39m
 [32m✓[39m src/app/api/ebs-pose-feedback/route.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 22[2mms[22m[39m
 [32m✓[39m src/lib/bodyPixOverlayGenerator.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 42[2mms[22m[39m
 [32m✓[39m src/lib/overlaySegments.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 11[2mms[22m[39m
 [32m✓[39m src/components/SegmentOverlay.test.tsx [2m([22m[2m4 tests[22m[2m)[22m[32m 91[2mms[22m[39m
 [32m✓[39m src/components/BodyPixOverlay.test.tsx [2m([22m[2m2 tests[22m[2m)[22m[32m 73[2mms[22m[39m
 [32m✓[39m src/components/ProgressiveOverlay.test.tsx [2m([22m[2m5 tests[22m[2m)[22m[32m 53[2mms[22m[39m
 [32m✓[39m src/components/ebs/types.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 13[2mms[22m[39m
 [32m✓[39m src/lib/bodyPixComparison.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 8[2mms[22m[39m
 [32m✓[39m src/app/upload/page.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 121[2mms[22m[39m
 [32m✓[39m src/app/api/process/route.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 24[2mms[22m[39m
 [32m✓[39m src/app/api/init-webrtc/route.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 21[2mms[22m[39m
 [32m✓[39m src/components/ebs/ebsViewerLogic.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 14[2mms[22m[39m
 [32m✓[39m src/lib/videoStorage.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 24[2mms[22m[39m
 [32m✓[39m src/lib/sam3OverlayStorage.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 27[2mms[22m[39m
 [32m✓[39m src/app/analysis/page.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 49[2mms[22m[39m
 [32m✓[39m src/lib/useDiffmap.test.ts [2m([22m[2m1 test[22m[2m)[22m[32m 40[2mms[22m[39m
 [32m✓[39m src/lib/normalization.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 12[2mms[22m[39m
 [32m✓[39m src/components/ebs/FeedbackOverlay.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 44[2mms[22m[39m
 [32m✓[39m src/app/api/upload/route.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 17[2mms[22m[39m
 [32m✓[39m src/app/layout.test.tsx [2m([22m[2m5 tests[22m[2m)[22m[32m 49[2mms[22m[39m
 [32m✓[39m src/components/PoseOverlay.test.tsx [2m([22m[2m2 tests[22m[2m)[22m[32m 66[2mms[22m[39m
 [32m✓[39m src/lib/overlayStorage.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 17[2mms[22m[39m
 [32m✓[39m src/lib/yoloOverlayStorage.test.ts [2m([22m[2m1 test[22m[2m)[22m[32m 19[2mms[22m[39m
 [32m✓[39m src/app/page.test.tsx [2m([22m[2m2 tests[22m[2m)[22m[32m 77[2mms[22m[39m
 [32m✓[39m src/components/ebs/DifferenceViewer.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 70[2mms[22m[39m
 [32m✓[39m src/components/PrecomputedVideoOverlay.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 48[2mms[22m[39m
 [32m✓[39m src/lib/ebsStorage.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 14[2mms[22m[39m
 [32m✓[39m src/components/PrecomputedFrameOverlay.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 41[2mms[22m[39m
 [32m✓[39m src/app/ebs-viewer/page.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 20[2mms[22m[39m

[2m Test Files [22m [1m[32m45 passed[39m[22m[90m (45)[39m
[2m      Tests [22m [1m[32m240 passed[39m[22m[90m (240)[39m
[2m   Start at [22m 00:46:13
[2m   Duration [22m 16.91s[2m (transform 1.62s, setup 10.96s, import 2.81s, tests 5.29s, environment 17.28s)[22m

[34m % [39m[2mCoverage report from [22m[33mv8[39m
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
-------------------|---------|----------|---------|---------|-------------------
All files          |    52.5 |    36.56 |   56.18 |   53.58 |                   
 app               |     100 |      100 |     100 |     100 |                   
  layout.tsx       |     100 |      100 |     100 |     100 |                   
  page.tsx         |     100 |      100 |     100 |     100 |                   
 app/analysis      |   31.85 |    18.54 |    37.5 |   31.73 |                   
  page.tsx         |   31.85 |    18.54 |    37.5 |   31.73 | ...94-497,514-613 
 app/api/coach     |   96.66 |    85.71 |     100 |   96.66 |                   
  route.ts         |   96.66 |    85.71 |     100 |   96.66 | 72                
 ...-pose-feedback |   82.66 |    66.66 |   88.88 |    85.5 |                   
  route.ts         |   82.66 |    66.66 |   88.88 |    85.5 | ...36,179,185-186 
 ...pi/init-webrtc |   83.33 |    85.71 |     100 |   83.33 |                   
  route.ts         |   83.33 |    85.71 |     100 |   83.33 | 72-74             
 app/api/process   |   96.87 |    77.77 |     100 |   96.87 |                   
  route.ts         |   96.87 |    77.77 |     100 |   96.87 | 24                
 ...api/sam3/frame |     100 |    78.94 |     100 |     100 |                   
  route.ts         |     100 |    78.94 |     100 |     100 | 37-38,54-61       
 ...api/sam3/video |   86.11 |    76.08 |     100 |   86.11 |                   
  route.ts         |   86.11 |    76.08 |     100 |   86.11 | 52,75-76,98-99    
 app/api/upload    |   88.23 |    78.57 |     100 |   88.23 |                   
  route.ts         |   88.23 |    78.57 |     100 |   88.23 | 57-58             
 app/dashboard     |     100 |       70 |     100 |     100 |                   
  page.tsx         |     100 |       70 |     100 |     100 | 80,87             
 app/ebs-viewer    |     100 |      100 |     100 |     100 |                   
  page.tsx         |     100 |      100 |     100 |     100 |                   
 app/upload        |   28.16 |    23.07 |   29.62 |   28.65 |                   
  page.tsx         |   28.16 |    23.07 |   29.62 |   28.65 | ...55-300,310-311 
 components        |   34.39 |    20.75 |   48.21 |   35.57 |                   
  ...ixOverlay.tsx |   36.55 |    30.61 |   71.42 |    37.5 | 66-149            
  PoseOverlay.tsx  |   19.08 |     9.92 |      45 |   19.67 | ...13-337,345-383 
  ...meOverlay.tsx |    31.3 |    15.06 |   33.33 |   32.69 | ...3,50-52,69-162 
  ...eoOverlay.tsx |   54.41 |     9.09 |   46.66 |    62.5 | ...68,71-73,78,81 
  ...veOverlay.tsx |   37.28 |    22.37 |   47.22 |    38.3 | ...94,298-304,371 
  ...eoOverlay.tsx |   94.87 |    86.36 |      80 |   94.44 | 74-75             
  ...ntOverlay.tsx |   33.33 |    25.86 |   47.05 |   35.16 | ...47-287,309-347 
 components/ebs    |   25.51 |    18.09 |   19.79 |   26.44 |                   
  ...nceViewer.tsx |   84.78 |    92.85 |   66.66 |    87.8 | 46,57,63-64,94    
  EbsViewer.tsx    |       0 |        0 |       0 |       0 | 64-2241           
  ...ckOverlay.tsx |   22.27 |    16.34 |   38.09 |   23.49 | ...25-239,257-355 
  ...backPanel.tsx |     0.9 |        0 |       0 |       1 | 35-346            
  ...ackViewer.tsx |   61.47 |    43.72 |   44.44 |   64.84 | ...03-604,641-838 
  ...backPanel.tsx |    3.14 |        0 |       0 |    3.47 | 10-11,61-426      
  ...iewerLogic.ts |   81.81 |    73.52 |   83.33 |   93.33 | 7-8               
  types.ts         |       0 |        0 |       0 |       0 |                   
  useEbsViewer.ts  |   56.37 |    36.69 |   42.55 |    61.5 | ...68,475-479,509 
 .../ebs/__mocks__ |      70 |      100 |      40 |     100 |                   
  ...iewerLogic.ts |      70 |      100 |      40 |     100 |                   
 lib               |   85.56 |    72.93 |   86.95 |   88.64 |                   
  analysis.ts      |     100 |    68.08 |     100 |     100 | ...29-181,191-199 
  ...Comparison.ts |       0 |        0 |       0 |       0 |                   
  ...yGenerator.ts |    93.4 |    73.33 |    90.9 |   96.47 | 62-63,114         
  ebsStorage.ts    |    90.9 |       75 |   83.33 |     100 | 16                
  ...emporalLlm.ts |     100 |      100 |     100 |     100 |                   
  ...yGenerator.ts |   94.07 |    67.64 |   93.75 |   98.38 | 44-45             
  ...yGenerator.ts |   89.16 |    73.46 |   85.71 |   89.65 | 14-15,38,43,91-98 
  normalization.ts |   70.58 |    61.11 |   83.33 |   70.96 | 100-113           
  ...aySegments.ts |      80 |    67.08 |      85 |   88.37 | 31,60,82,112,136  
  ...layStorage.ts |   91.17 |    83.33 |   83.33 |     100 | 58                
  poseAnalysis.ts  |   94.68 |    73.33 |      92 |    97.5 | 55-56             
  ...layStorage.ts |   93.47 |    70.83 |   80.76 |     100 | 25-86,121,133,152 
  ...ionStorage.ts |      88 |    73.33 |     100 |   97.56 | 108               
  useDiffmap.ts    |   19.04 |    18.18 |   66.66 |    17.5 | 17-59             
  videoStorage.ts  |    92.1 |       75 |   86.95 |     100 | 16                
  ...yGenerator.ts |    66.9 |    55.55 |   70.96 |   71.25 | ...18,428-429,439 
  ...layStorage.ts |   89.87 |       60 |   78.26 |   96.87 | 104-105           
 lib/bodyPix       |     100 |    97.08 |     100 |     100 |                   
  beatFeedback.ts  |     100 |     92.5 |     100 |     100 | 197-215           
  compare.ts       |     100 |      100 |     100 |     100 |                   
  constants.ts     |     100 |      100 |     100 |     100 |                   
  feedbackCopy.ts  |     100 |      100 |     100 |     100 |                   
  geometry.ts      |     100 |      100 |     100 |     100 |                   
  index.ts         |       0 |        0 |       0 |       0 |                   
  ...onFeatures.ts |     100 |      100 |     100 |     100 |                   
  segmentation.ts  |     100 |      100 |     100 |     100 |                   
  stats.ts         |     100 |      100 |     100 |     100 |                   
  timestamps.ts    |     100 |      100 |     100 |     100 |                   
  types.ts         |     100 |      100 |     100 |     100 |                   
-------------------|---------|----------|---------|---------|-------------------
```
