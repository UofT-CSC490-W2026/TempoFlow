# Web App Test Coverage Report

*Last Updated: Fri Mar 27 02:00:49 UTC 2026*

```text

> web-app@0.1.0 coverage
> vitest run --coverage


[1m[46m RUN [49m[22m [36mv4.1.2 [39m[90m/home/runner/work/TempoFlow/TempoFlow/web-app[39m
      [2mCoverage enabled with [22m[33mv8[39m

 [32m✓[39m src/lib/bodyPix/compare.integration.test.ts [2m([22m[2m19 tests[22m[2m)[22m[32m 275[2mms[22m[39m
 [32m✓[39m src/lib/analysis.test.ts [2m([22m[2m11 tests[22m[2m)[22m[32m 32[2mms[22m[39m
 [32m✓[39m src/lib/ebsTemporalLlm.test.ts [2m([22m[2m27 tests[22m[2m)[22m[32m 36[2mms[22m[39m
 [32m✓[39m src/lib/bodyPix/pure.test.ts [2m([22m[2m30 tests[22m[2m)[22m[32m 28[2mms[22m[39m
 [32m✓[39m src/lib/sessionStorage.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 27[2mms[22m[39m
 [32m✓[39m src/app/dashboard/page.test.tsx [2m([22m[2m3 tests[22m[2m)[22m[33m 562[2mms[22m[39m
     [33m[2m✓[22m[39m renders the empty state when there are no saved sessions [33m 326[2mms[22m[39m
 [32m✓[39m src/app/api/ebs-pose-feedback/route.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 30[2mms[22m[39m
 [32m✓[39m src/lib/overlaySegments.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 11[2mms[22m[39m
 [32m✓[39m src/components/ProgressiveOverlay.test.tsx [2m([22m[2m5 tests[22m[2m)[22m[32m 78[2mms[22m[39m
 [32m✓[39m src/lib/bodyPixComparison.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 12[2mms[22m[39m
 [32m✓[39m src/app/api/process/route.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 33[2mms[22m[39m
 [32m✓[39m src/app/api/init-webrtc/route.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 24[2mms[22m[39m
 [32m✓[39m src/components/ebs/ebsViewerLogic.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 12[2mms[22m[39m
 [32m✓[39m src/lib/videoStorage.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 29[2mms[22m[39m
 [32m✓[39m src/app/api/coach/route.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 25[2mms[22m[39m
 [32m✓[39m src/lib/normalization.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 9[2mms[22m[39m
 [32m✓[39m src/app/api/upload/route.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 25[2mms[22m[39m
 [32m✓[39m src/components/PoseOverlay.test.tsx [2m([22m[2m2 tests[22m[2m)[22m[32m 82[2mms[22m[39m
 [32m✓[39m src/lib/overlayStorage.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 17[2mms[22m[39m
 [32m✓[39m src/app/page.test.tsx [2m([22m[2m2 tests[22m[2m)[22m[33m 321[2mms[22m[39m
     [33m[2m✓[22m[39m renders the main call-to-action links [33m 301[2mms[22m[39m
 [32m✓[39m src/components/ebs/DifferenceViewer.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 102[2mms[22m[39m
 [32m✓[39m src/components/PrecomputedVideoOverlay.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 68[2mms[22m[39m
 [32m✓[39m src/components/PrecomputedFrameOverlay.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 49[2mms[22m[39m
 [32m✓[39m src/lib/ebsStorage.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 13[2mms[22m[39m

[2m Test Files [22m [1m[32m24 passed[39m[22m[90m (24)[39m
[2m      Tests [22m [1m[32m153 passed[39m[22m[90m (153)[39m
[2m   Start at [22m 02:00:35
[2m   Duration [22m 14.21s[2m (transform 809ms, setup 5.55s, import 1.16s, tests 1.90s, environment 23.77s)[22m

[34m % [39m[2mCoverage report from [22m[33mv8[39m
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
-------------------|---------|----------|---------|---------|-------------------
All files          |   24.38 |    19.06 |    31.1 |   24.01 |                   
 app               |      20 |      100 |      50 |      20 |                   
  layout.tsx       |       0 |      100 |       0 |       0 | 5-25              
  page.tsx         |     100 |      100 |     100 |     100 |                   
 app/analysis      |       0 |        0 |       0 |       0 |                   
  page.tsx         |       0 |        0 |       0 |       0 | 21-671            
 app/api/coach     |   76.66 |    78.57 |     100 |   76.66 |                   
  route.ts         |   76.66 |    78.57 |     100 |   76.66 | 63-65,72,83,88-89 
 ...-pose-feedback |   82.66 |    66.66 |   88.88 |    85.5 |                   
  route.ts         |   82.66 |    66.66 |   88.88 |    85.5 | ...36,179,185-186 
 ...pi/init-webrtc |   83.33 |    85.71 |     100 |   83.33 |                   
  route.ts         |   83.33 |    85.71 |     100 |   83.33 | 72-74             
 app/api/process   |   96.87 |    77.77 |     100 |   96.87 |                   
  route.ts         |   96.87 |    77.77 |     100 |   96.87 | 24                
 ...api/sam3/frame |       0 |        0 |       0 |       0 |                   
  route.ts         |       0 |        0 |       0 |       0 | 17-71             
 ...api/sam3/video |       0 |        0 |       0 |       0 |                   
  route.ts         |       0 |        0 |       0 |       0 | 4-99              
 app/api/upload    |   88.23 |    78.57 |     100 |   88.23 |                   
  route.ts         |   88.23 |    78.57 |     100 |   88.23 | 57-58             
 app/dashboard     |     100 |       70 |     100 |     100 |                   
  page.tsx         |     100 |       70 |     100 |     100 | 80,87             
 app/ebs-viewer    |       0 |      100 |       0 |       0 |                   
  page.tsx         |       0 |      100 |       0 |       0 | 4                 
 app/upload        |       0 |        0 |       0 |       0 |                   
  page.tsx         |       0 |        0 |       0 |       0 | 16-353            
 components        |   20.67 |     11.5 |   33.03 |   21.47 |                   
  ...ixOverlay.tsx |       0 |        0 |       0 |       0 | 21-155            
  PoseOverlay.tsx  |   19.08 |     9.92 |      45 |   19.67 | ...13-337,345-383 
  ...meOverlay.tsx |    31.3 |    15.06 |   33.33 |   32.69 | ...3,50-52,69-162 
  ...eoOverlay.tsx |   54.41 |     9.09 |   46.66 |    62.5 | ...68,71-73,78,81 
  ...veOverlay.tsx |   37.28 |    22.37 |   47.22 |    38.3 | ...94,298-304,371 
  ...eoOverlay.tsx |       0 |        0 |       0 |       0 | 29-90             
  ...ntOverlay.tsx |       0 |        0 |       0 |       0 | 7-376             
 components/ebs    |    4.52 |     3.94 |    3.69 |     4.3 |                   
  ...nceViewer.tsx |   84.78 |    92.85 |   66.66 |    87.8 | 46,57,63-64,94    
  EbsViewer.tsx    |       0 |        0 |       0 |       0 | 64-2241           
  ...ckOverlay.tsx |       0 |        0 |       0 |       0 | 19-370            
  ...backPanel.tsx |       0 |        0 |       0 |       0 | 27-346            
  ...ackViewer.tsx |       0 |        0 |       0 |       0 | 41-838            
  ...backPanel.tsx |       0 |        0 |       0 |       0 | 7-426             
  ...iewerLogic.ts |   81.81 |    73.52 |   83.33 |   93.33 | 7-8               
  types.ts         |       0 |        0 |       0 |       0 |                   
  useEbsViewer.ts  |       0 |        0 |       0 |       0 | 86-553            
 lib               |   33.59 |    43.12 |    45.7 |   32.63 |                   
  analysis.ts      |     100 |    68.08 |     100 |     100 | ...29-181,191-199 
  ...Comparison.ts |       0 |        0 |       0 |       0 |                   
  ...yGenerator.ts |       0 |        0 |       0 |       0 | 6-183             
  ebsStorage.ts    |    90.9 |       75 |   83.33 |     100 | 16                
  ...emporalLlm.ts |     100 |      100 |     100 |     100 |                   
  ...yGenerator.ts |       0 |        0 |       0 |       0 | 5-209             
  ...yGenerator.ts |       0 |        0 |       0 |       0 | 5-192             
  normalization.ts |     100 |     87.5 |     100 |     100 | 22                
  ...aySegments.ts |      80 |    67.08 |      85 |   88.37 | 31,60,82,112,136  
  ...layStorage.ts |   91.17 |    83.33 |   83.33 |     100 | 58                
  poseAnalysis.ts  |       0 |        0 |       0 |       0 | 9-172             
  ...layStorage.ts |       0 |        0 |       0 |       0 | 3-155             
  ...ionStorage.ts |      88 |    73.33 |     100 |   97.56 | 108               
  videoStorage.ts  |    92.1 |       75 |   86.95 |     100 | 16                
  ...yGenerator.ts |       0 |        0 |       0 |       0 | 5-464             
  ...layStorage.ts |       0 |        0 |       0 |       0 | 3-132             
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
