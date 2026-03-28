import { useState, useEffect, useRef } from 'react';

export function useDifferenceMap(
  instructorFrameUrl: string | null,
  userFrameUrl: string | null,
  width: number,
  height: number
) {
  const [xorMaskUrl, setXorMaskUrl] = useState<string | null>(null);
  const [colorBase64, setColorBase64] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !instructorFrameUrl || !userFrameUrl) return;

    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return;

    canvas.width = width;
    canvas.height = height;

    const instructorImg = new Image();
    const userImg = new Image();
    let loadedCount = 0;

    const onImageLoad = () => {
      loadedCount++;
      if (loadedCount === 2) {
        // 1. Generate the XOR Mask (The "Delta")
        ctx.clearRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(userImg, 0, 0, width, height);
        ctx.globalCompositeOperation = 'source-in';
        ctx.fillStyle = 'white';
        ctx.fillRect(0, 0, width, height);
        ctx.globalCompositeOperation = 'xor';
        ctx.drawImage(instructorImg, 0, 0, width, height);
        setXorMaskUrl(canvas.toDataURL('image/png'));

        // 2. Generate the Magenta Silhouette
        const magentaCanvas = document.createElement('canvas');
        magentaCanvas.width = width;
        magentaCanvas.height = height;
        const mCtx = magentaCanvas.getContext('2d');
        if (mCtx) {
          mCtx.drawImage(userImg, 0, 0, width, height);
          mCtx.globalCompositeOperation = 'source-in';
          mCtx.fillStyle = 'rgb(255, 0, 255)';
          mCtx.fillRect(0, 0, width, height);
          setColorBase64(magentaCanvas.toDataURL('image/png'));
        }
      }
    };

    instructorImg.onload = onImageLoad;
    userImg.onload = onImageLoad;
    instructorImg.src = instructorFrameUrl;
    userImg.src = userFrameUrl;
  }, [instructorFrameUrl, userFrameUrl, width, height]);

  return { xorMaskUrl, colorBase64, hiddenCanvasRef: canvasRef };
}