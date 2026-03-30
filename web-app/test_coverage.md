# Web App Test Coverage Report

*Last Updated: Mon Mar 30 21:48:53 UTC 2026*

```text

> web-app@0.1.0 coverage
> vitest run --coverage


[1m[46m RUN [49m[22m [36mv4.1.2 [39m[90m/home/runner/work/TempoFlow/TempoFlow/web-app[39m
      [2mCoverage enabled with [22m[33mv8[39m

 [32m✓[39m src/components/ebs/GeminiFeedbackPanel.test.tsx [2m([22m[2m6 tests[22m[2m)[22m[32m 120[2mms[22m[39m
 [32m✓[39m src/lib/bodyPix/compare.integration.test.ts [2m([22m[2m19 tests[22m[2m)[22m[33m 346[2mms[22m[39m
 [32m✓[39m src/lib/analysis.test.ts [2m([22m[2m11 tests[22m[2m)[22m[32m 40[2mms[22m[39m
 [32m✓[39m src/lib/bodyPix/pure.test.ts [2m([22m[2m34 tests[22m[2m)[22m[32m 21[2mms[22m[39m
 [32m✓[39m src/components/ebs/FeedbackViewer.test.tsx [2m([22m[2m31 tests[22m[2m)[22m[33m 1679[2mms[22m[39m
 [32m✓[39m src/app/dashboard/page.test.tsx [2m([22m[2m4 tests[22m[2m)[22m[32m 154[2mms[22m[39m
[90mstdout[2m | src/components/ebs/useEbsViewer.test.ts[2m > [22m[2museEbsViewer[2m > [22m[2mtoggles playback and updates video state
[22m[39m[DEBUG] togglePlay called, playingRef.current: [33mfalse[39m overlayVideo?.current: null
[DEBUG] startPlayback called, overlayVideo?.current: null
[DEBUG] togglePlay called, playingRef.current: [33mtrue[39m overlayVideo?.current: null

[90mstdout[2m | src/components/ebs/useEbsViewer.test.ts[2m > [22m[2museEbsViewer[2m > [22m[2mtriggers pause overlay when a segment completes
[22m[39m[DEBUG] togglePlay called, playingRef.current: [33mfalse[39m overlayVideo?.current: null
[DEBUG] startPlayback called, overlayVideo?.current: null

 [32m✓[39m src/components/ebs/useEbsViewer.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 63[2mms[22m[39m
 [32m✓[39m src/app/upload/page.test.tsx [2m([22m[2m3 tests[22m[2m)[22m[32m 225[2mms[22m[39m
 [32m✓[39m src/lib/fastSamOverlayGenerator.test.ts [2m([22m[2m9 tests[22m[2m)[22m[33m 1688[2mms[22m[39m
     [33m[2m✓[22m[39m generates frames at 30 FPS for the full duration [33m 317[2mms[22m[39m
     [33m[2m✓[22m[39m triggers onProgress for every frame generated [33m 312[2mms[22m[39m
     [33m[2m✓[22m[39m generates frames at 30 FPS for the full duration [33m 348[2mms[22m[39m
 [32m✓[39m src/lib/yoloOverlayGenerator.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 182[2mms[22m[39m
 [32m✓[39m src/lib/movenetOverlayGenerator.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 272[2mms[22m[39m
 [32m✓[39m src/components/SegmentOverlay.test.tsx [2m([22m[2m5 tests[22m[2m)[22m[32m 78[2mms[22m[39m
 [32m✓[39m src/lib/ensureBrowserYoloOverlays.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 25[2mms[22m[39m
 [32m✓[39m src/app/api/coach/route.test.ts [2m([22m[2m6 tests[22m[2m)[22m[32m 30[2mms[22m[39m
 [32m✓[39m src/lib/bodyPixOverlayGenerator.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 50[2mms[22m[39m
 [32m✓[39m src/lib/poseAnalysis.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 190[2mms[22m[39m
 [32m✓[39m src/lib/sessionStorage.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 19[2mms[22m[39m
 [32m✓[39m src/components/ebs/EbsViewer.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 76[2mms[22m[39m
 [32m✓[39m src/components/RoboflowVideoOverlay.test.tsx [2m([22m[2m4 tests[22m[2m)[22m[32m 67[2mms[22m[39m
 [32m✓[39m src/lib/overlaySegments.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 12[2mms[22m[39m
 [32m✓[39m src/components/BodyPixOverlay.test.tsx [2m([22m[2m2 tests[22m[2m)[22m[32m 67[2mms[22m[39m
 [32m✓[39m src/components/ProgressiveOverlay.test.tsx [2m([22m[2m5 tests[22m[2m)[22m[32m 63[2mms[22m[39m
 [32m✓[39m src/components/ebs/types.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 13[2mms[22m[39m
 [32m✓[39m src/lib/yoloFeedback.test.ts [2m([22m[2m1 test[22m[2m)[22m[32m 14[2mms[22m[39m
 [32m✓[39m src/lib/bodyPixComparison.test.ts [2m([22m[2m5 tests[22m[2m)[22m[32m 12[2mms[22m[39m
 [32m✓[39m src/components/PoseOverlay.test.tsx [2m([22m[2m3 tests[22m[2m)[22m[32m 167[2mms[22m[39m
 [32m✓[39m src/app/api/process/route.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 18[2mms[22m[39m
 [32m✓[39m src/components/ebs/feedbackDifficulty.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 11[2mms[22m[39m
 [32m✓[39m src/lib/bodyPix/overlayMaskStyling.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 9[2mms[22m[39m
 [32m✓[39m src/app/page.test.tsx [2m([22m[2m3 tests[22m[2m)[22m[32m 137[2mms[22m[39m
 [32m✓[39m src/app/api/init-webrtc/route.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 20[2mms[22m[39m
 [32m✓[39m src/components/ebs/ebsViewerLogic.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 15[2mms[22m[39m
 [32m✓[39m src/lib/videoStorage.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 19[2mms[22m[39m
 [32m✓[39m src/components/ebs/overlayVisualFeedback.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 11[2mms[22m[39m
 [32m✓[39m src/lib/sam3OverlayStorage.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 25[2mms[22m[39m
 [32m✓[39m src/app/analysis/page.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 69[2mms[22m[39m
 [32m✓[39m src/lib/normalization.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 11[2mms[22m[39m
 [32m✓[39m src/app/api/upload/route.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 17[2mms[22m[39m
 [32m✓[39m src/app/layout.test.tsx [2m([22m[2m5 tests[22m[2m)[22m[32m 67[2mms[22m[39m
 [32m✓[39m src/lib/feedbackStorage.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 18[2mms[22m[39m
 [32m✓[39m src/lib/overlayStorage.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 19[2mms[22m[39m
 [32m✓[39m src/lib/yoloOverlayStorage.test.ts [2m([22m[2m1 test[22m[2m)[22m[32m 29[2mms[22m[39m
 [32m✓[39m src/lib/geminiDebugInfo.test.ts [2m([22m[2m1 test[22m[2m)[22m[32m 7[2mms[22m[39m
 [32m✓[39m src/components/ebs/DifferenceViewer.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 82[2mms[22m[39m
 [32m✓[39m src/components/PrecomputedVideoOverlay.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 53[2mms[22m[39m
 [32m✓[39m src/components/PrecomputedFrameOverlay.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 45[2mms[22m[39m
 [32m✓[39m src/lib/ebsStorage.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 14[2mms[22m[39m
 [32m✓[39m src/app/ebs-viewer/page.test.tsx [2m([22m[2m1 test[22m[2m)[22m[32m 20[2mms[22m[39m

[2m Test Files [22m [1m[32m48 passed[39m[22m[90m (48)[39m
[2m      Tests [22m [1m[32m251 passed[39m[22m[90m (251)[39m
[2m   Start at [22m 21:48:34
[2m   Duration [22m 18.26s[2m (transform 2.23s, setup 11.34s, import 3.41s, tests 6.39s, environment 18.41s)[22m

[34m % [39m[2mCoverage report from [22m[33mv8[39m
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
-------------------|---------|----------|---------|---------|-------------------
All files          |   55.58 |    44.97 |   61.32 |   57.25 |                   
 app               |     100 |      100 |     100 |     100 |                   
  layout.tsx       |     100 |      100 |     100 |     100 |                   
  page.tsx         |     100 |      100 |     100 |     100 |                   
 app/analysis      |   44.78 |    17.02 |      50 |   44.37 |                   
  page.tsx         |   44.78 |    17.02 |      50 |   44.37 | ...67-270,288-515 
 .../[...nextauth] |       0 |      100 |     100 |       0 |                   
  route.ts         |       0 |      100 |     100 |       0 | 4                 
 app/api/coach     |   96.66 |    85.71 |     100 |   96.66 |                   
  route.ts         |   96.66 |    85.71 |     100 |   96.66 | 72                
 ...pi/init-webrtc |   83.33 |    85.71 |     100 |   83.33 |                   
  route.ts         |   83.33 |    85.71 |     100 |   83.33 | 72-74             
 app/api/process   |   94.87 |       75 |     100 |   97.29 |                   
  route.ts         |   94.87 |       75 |     100 |   97.29 | 32                
 app/api/upload    |   88.23 |    78.57 |     100 |   88.23 |                   
  route.ts         |   88.23 |    78.57 |     100 |   88.23 | 57-58             
 app/dashboard     |   75.49 |    67.64 |   89.65 |   79.12 |                   
  page.tsx         |   75.49 |    67.64 |   89.65 |   79.12 | ...40-144,158-170 
 app/ebs-viewer    |     100 |      100 |     100 |     100 |                   
  page.tsx         |     100 |      100 |     100 |     100 |                   
 app/login         |       0 |      100 |       0 |       0 |                   
  page.tsx         |       0 |      100 |       0 |       0 | 8-32              
 app/upload        |    42.8 |    44.77 |   48.93 |   43.31 |                   
  page.tsx         |    42.8 |    44.77 |   48.93 |   43.31 | ...81-485,549-550 
 components        |   29.27 |    18.74 |   33.33 |   30.71 |                   
  AppHeader.tsx    |     100 |      100 |     100 |     100 |                   
  ...Processor.tsx |       0 |        0 |       0 |       0 | 55-619            
  ...ixOverlay.tsx |   36.55 |       32 |   71.42 |    37.5 | 68-151            
  PoseOverlay.tsx  |   20.61 |    12.05 |      45 |   21.28 | ...13-337,353-387 
  ...meOverlay.tsx |    31.3 |    19.48 |   33.33 |   32.69 | ...5,52-54,71-164 
  ...eoOverlay.tsx |   56.66 |    16.41 |   42.85 |   62.02 | ...97,102,105,117 
  ...veOverlay.tsx |   39.51 |    26.94 |   44.11 |    40.8 | ...29-331,342,439 
  Providers.tsx    |       0 |        0 |       0 |       0 | 9-12              
  ...eoOverlay.tsx |   94.87 |    86.36 |      80 |   94.44 | 74-75             
  ...ntOverlay.tsx |   33.33 |    27.58 |   47.05 |   35.16 | ...47-287,309-347 
 components/ebs    |   54.99 |    47.78 |   58.53 |   56.97 |                   
  ...nceViewer.tsx |   84.78 |    92.85 |   66.66 |    87.8 | 46,57,63-64,94    
  EbsViewer.tsx    |   22.24 |    25.96 |   17.34 |   23.07 | ...1864,1898-2095 
  ...ackViewer.tsx |   62.46 |    52.75 |   69.29 |   64.89 | ...2950-2951,3018 
  ...backPanel.tsx |   77.66 |    56.75 |   71.92 |   82.39 | ...21,556,595-608 
  ...MaskLayer.tsx |       0 |        0 |       0 |       0 | 32-131            
  ...lFeedback.tsx |   92.39 |    86.36 |     100 |   92.39 | 75-78,174-175,240 
  ...iewerLogic.ts |   86.36 |    79.41 |   83.33 |   93.33 | 7-8               
  ...Difficulty.ts |   77.41 |     61.4 |   83.33 |   85.41 | ...10,119,132-142 
  ...cutTargets.ts |   72.72 |    66.66 |     100 |      70 | 5,9,17            
  ...eedbackCue.ts |   53.44 |    46.09 |   75.51 |   55.77 | ...72-489,497-501 
  types.ts         |       0 |        0 |       0 |       0 |                   
  useEbsViewer.ts  |   57.79 |    36.78 |   45.28 |   61.48 | ...64,571-575,606 
 .../ebs/__mocks__ |      70 |      100 |      40 |     100 |                   
  ...iewerLogic.ts |      70 |      100 |      40 |     100 |                   
 lib               |   59.87 |    43.37 |   66.19 |   62.09 |                   
  analysis.ts      |     100 |    68.08 |     100 |     100 | ...29-181,191-199 
  auth-options.ts  |       0 |        0 |       0 |       0 | 6-37              
  ...Comparison.ts |       0 |        0 |       0 |       0 |                   
  ...yGenerator.ts |   93.67 |    76.92 |    90.9 |      96 | 37-38,89          
  dynamodb.ts      |       0 |      100 |     100 |       0 | 4-13              
  ...ocessorUrl.ts |      50 |       25 |   33.33 |   57.14 | 13,19-23          
  ...essionMeta.ts |       0 |      100 |       0 |       0 | 5                 
  ebsStorage.ts    |    90.9 |       75 |   83.33 |     100 | 16                
  ...ixOverlays.ts |       0 |        0 |       0 |       0 | 15-349            
  ...loOverlays.ts |   43.22 |    37.89 |   38.46 |   44.34 | ...1375,1423-1515 
  ...yGenerator.ts |   94.07 |    67.64 |   93.75 |   98.38 | 44-45             
  ...ackStorage.ts |   93.33 |    81.81 |   84.21 |     100 | 30-44             
  ...iDebugInfo.ts |     100 |    93.75 |     100 |     100 | 36                
  ...dbackTypes.ts |       0 |        0 |       0 |       0 |                   
  ...PosePriors.ts |       0 |        0 |       0 |       0 | 15-242            
  ...oloContext.ts |   90.47 |       70 |     100 |     100 | ...11-112,116-125 
  ...yGenerator.ts |   89.16 |    73.46 |   85.71 |   89.65 | 14-15,38,43,91-98 
  normalization.ts |   70.58 |    61.11 |   83.33 |   70.96 | 100-113           
  ...aySegments.ts |      94 |    81.01 |      95 |   95.34 | 112,136           
  ...layStorage.ts |   91.17 |    83.33 |   83.33 |     100 | 58                
  poseAnalysis.ts  |   94.68 |    73.33 |      92 |    97.5 | 55-56             
  ...layStorage.ts |   93.47 |    70.83 |   80.76 |     100 | 25-86,121,133,152 
  ...Processing.ts |       0 |        0 |       0 |       0 | 5-51              
  ...Processing.ts |    2.07 |        0 |       0 |    2.27 | 43-386            
  ...ionStorage.ts |   77.96 |    68.75 |      85 |   85.71 | 117,206-212       
  videoStorage.ts  |    92.1 |       75 |   86.95 |     100 | 16                
  ...ackStorage.ts |       0 |        0 |       0 |       0 | 3-70              
  yoloFeedback.ts  |   76.15 |    45.96 |   91.42 |   85.57 | ...67-168,287-291 
  ...yGenerator.ts |    66.9 |    55.55 |   70.96 |   71.25 | ...18,428-429,439 
  ...layStorage.ts |   89.87 |       60 |   78.26 |   96.87 | 104-105           
 lib/bodyPix       |   97.72 |    90.34 |     100 |   99.17 |                   
  beatFeedback.ts  |   96.53 |    88.65 |     100 |    98.9 | 202,296           
  compare.ts       |     100 |      100 |     100 |     100 |                   
  constants.ts     |     100 |      100 |     100 |     100 |                   
  feedbackCopy.ts  |     100 |      100 |     100 |     100 |                   
  geometry.ts      |     100 |    97.43 |     100 |     100 | 51                
  index.ts         |       0 |        0 |       0 |       0 |                   
  ...onFeatures.ts |     100 |      100 |     100 |     100 |                   
  ...askStyling.ts |   95.74 |    82.71 |     100 |   98.23 | 148-149           
  palette.ts       |     100 |      100 |     100 |     100 |                   
  segmentation.ts  |     100 |      100 |     100 |     100 |                   
  stats.ts         |     100 |      100 |     100 |     100 |                   
  timestamps.ts    |     100 |      100 |     100 |     100 |                   
  types.ts         |     100 |      100 |     100 |     100 |                   
-------------------|---------|----------|---------|---------|-------------------
```
