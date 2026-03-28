import { renderHook, waitFor } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useDifferenceMap } from "./useDiffmap";

describe("useDifferenceMap", () => {
  const mockInstructorUrl = "blob:instructor";
  const mockUserUrl = "blob:user";
  const width = 100;
  const height = 100;

  const mockCtx = {
    drawImage: vi.fn(),
    fillRect: vi.fn(),
    clearRect: vi.fn(),
    toDataURL: vi.fn().mockReturnValue("data:image/png;base64,result"),
    globalCompositeOperation: "source-over",
    fillStyle: "",
  };

  beforeEach(() => {
    vi.clearAllMocks();

    // 1. Mock the specific Image class used by the hook
    // We store the instances so we can manually call .onload()
    const imageInstances: any[] = [];
    vi.stubGlobal('Image', class {
      onload: () => void = () => {};
      _src: string = "";
      constructor() { imageInstances.push(this); }
      set src(val: string) {
        this._src = val;
        // Simulate async load
        setTimeout(() => this.onload(), 0);
      }
      get src() { return this._src; }
    });

    // 2. Mock Canvas getContext
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(mockCtx as any);
    vi.spyOn(HTMLCanvasElement.prototype, "toDataURL").mockReturnValue("data:image/png;base64,result");
  });

  it("creates a separate magenta silhouette canvas", async () => {
    // 3. Narrow the spy to only look for 'canvas'
    const createElementSpy = vi.spyOn(document, 'createElement');
    
    const { result } = renderHook(() =>
      useDifferenceMap(mockInstructorUrl, mockUserUrl, width, height)
    );

    // Populate ref
    (result.current.hiddenCanvasRef as any).current = document.createElement('canvas');

    await waitFor(() => {
      const canvasCalls = createElementSpy.mock.calls.filter(call => call[0] === 'canvas');
      expect(canvasCalls.length).toBeGreaterThan(0);
    });
  });
});