# Web App Test Coverage Report

*Last Updated: Fri Mar 27 00:11:03 UTC 2026*

```text

> web-app@0.1.0 coverage
> vitest run --coverage


[1m[46m RUN [49m[22m [36mv4.1.2 [39m[90m/home/runner/work/TempoFlow/TempoFlow/web-app[39m
      [2mCoverage enabled with [22m[33mv8[39m

 [32m✓[39m src/lib/bodyPix/compare.integration.test.ts [2m([22m[2m19 tests[22m[2m)[22m[32m 226[2mms[22m[39m
 [32m✓[39m src/lib/analysis.test.ts [2m([22m[2m11 tests[22m[2m)[22m[32m 31[2mms[22m[39m
 [32m✓[39m src/lib/ebsTemporalLlm.test.ts [2m([22m[2m27 tests[22m[2m)[22m[32m 35[2mms[22m[39m
 [32m✓[39m src/lib/bodyPix/pure.test.ts [2m([22m[2m30 tests[22m[2m)[22m[32m 28[2mms[22m[39m
 [32m✓[39m src/lib/sessionStorage.test.ts [2m([22m[2m8 tests[22m[2m)[22m[32m 28[2mms[22m[39m
 [32m✓[39m src/app/dashboard/page.test.tsx [2m([22m[2m3 tests[22m[2m)[22m[33m 562[2mms[22m[39m
     [33m[2m✓[22m[39m renders the empty state when there are no saved sessions [33m 327[2mms[22m[39m
 [32m✓[39m src/lib/overlaySegments.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 13[2mms[22m[39m
 [32m✓[39m src/lib/bodyPixComparison.test.ts [2m([22m[2m4 tests[22m[2m)[22m[32m 10[2mms[22m[39m
 [32m✓[39m src/lib/videoStorage.test.ts [2m([22m[2m3 tests[22m[2m)[22m[32m 26[2mms[22m[39m
 [32m✓[39m src/lib/overlayStorage.test.ts [2m([22m[2m2 tests[22m[2m)[22m[32m 14[2mms[22m[39m
 [32m✓[39m src/app/page.test.tsx [2m([22m[2m2 tests[22m[2m)[22m[32m 206[2mms[22m[39m

[2m Test Files [22m [1m[32m11 passed[39m[22m[90m (11)[39m
[2m      Tests [22m [1m[32m112 passed[39m[22m[90m (112)[39m
[2m   Start at [22m 00:10:55
[2m   Duration [22m 7.32s[2m (transform 506ms, setup 2.59s, import 562ms, tests 1.18s, environment 10.99s)[22m

[34m % [39m[2mCoverage report from [22m[33mv8[39m
-------------------|---------|----------|---------|---------|-------------------
File               | % Stmts | % Branch | % Funcs | % Lines | Uncovered Line #s 
-------------------|---------|----------|---------|---------|-------------------
All files          |   14.99 |     11.9 |   21.86 |   14.22 |                   
 app               |      20 |      100 |      50 |      20 |                   
  layout.tsx       |       0 |      100 |       0 |       0 | 5-25              
  page.tsx         |     100 |      100 |     100 |     100 |                   
 app/analysis      |       0 |        0 |       0 |       0 |                   
  page.tsx         |       0 |        0 |       0 |       0 | 21-671            
 app/api/coach     |       0 |        0 |       0 |       0 |                   
  route.ts         |       0 |        0 |       0 |       0 | 12-89             
 ...-pose-feedback |       0 |        0 |       0 |       0 |                   
  route.ts         |       0 |        0 |       0 |       0 | 10-186            
 ...pi/init-webrtc |       0 |        0 |       0 |       0 |                   
  route.ts         |       0 |        0 |       0 |       0 | 15-74             
 app/api/process   |       0 |        0 |       0 |       0 |                   
  route.ts         |       0 |        0 |       0 |       0 | 3-73              
 ...api/sam3/frame |       0 |        0 |       0 |       0 |                   
  route.ts         |       0 |        0 |       0 |       0 | 17-71             
 ...api/sam3/video |       0 |        0 |       0 |       0 |                   
  route.ts         |       0 |        0 |       0 |       0 | 4-99              
 app/api/upload    |       0 |        0 |       0 |       0 |                   
  route.ts         |       0 |        0 |       0 |       0 | 6-58              
 app/dashboard     |     100 |       70 |     100 |     100 |                   
  page.tsx         |     100 |       70 |     100 |     100 | 80,87             
 app/ebs-viewer    |       0 |      100 |       0 |       0 |                   
  page.tsx         |       0 |      100 |       0 |       0 | 4                 
 app/upload        |       0 |        0 |       0 |       0 |                   
  page.tsx         |       0 |        0 |       0 |       0 | 16-353            
 components        |       0 |        0 |       0 |       0 |                   
  ...ixOverlay.tsx |       0 |        0 |       0 |       0 | 21-155            
  PoseOverlay.tsx  |       0 |        0 |       0 |       0 | 13-405            
  ...meOverlay.tsx |       0 |        0 |       0 |       0 | 11-166            
  ...eoOverlay.tsx |       0 |        0 |       0 |       0 | 11-100            
  ...veOverlay.tsx |       0 |        0 |       0 |       0 | 11-371            
  ...eoOverlay.tsx |       0 |        0 |       0 |       0 | 29-90             
  ...ntOverlay.tsx |       0 |        0 |       0 |       0 | 7-376             
 components/ebs    |       0 |        0 |       0 |       0 |                   
  ...nceViewer.tsx |       0 |        0 |       0 |       0 | 22-103            
  EbsViewer.tsx    |       0 |        0 |       0 |       0 | 64-2241           
  ...ckOverlay.tsx |       0 |        0 |       0 |       0 | 19-370            
  ...backPanel.tsx |       0 |        0 |       0 |       0 | 27-346            
  ...ackViewer.tsx |       0 |        0 |       0 |       0 | 41-838            
  ...backPanel.tsx |       0 |        0 |       0 |       0 | 7-426             
  types.ts         |       0 |        0 |       0 |       0 |                   
  useEbsViewer.ts  |       0 |        0 |       0 |       0 | 76-591            
 lib               |   30.26 |    41.44 |    40.2 |   29.37 |                   
  analysis.ts      |     100 |    68.08 |     100 |     100 | ...29-181,191-199 
  ...Comparison.ts |       0 |        0 |       0 |       0 |                   
  ...yGenerator.ts |       0 |        0 |       0 |       0 | 6-183             
  ebsStorage.ts    |       0 |        0 |       0 |       0 | 3-54              
  ...emporalLlm.ts |     100 |      100 |     100 |     100 |                   
  ...yGenerator.ts |       0 |        0 |       0 |       0 | 5-209             
  ...yGenerator.ts |       0 |        0 |       0 |       0 | 5-192             
  normalization.ts |       0 |        0 |       0 |       0 | 9-31              
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
