import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { OverlayMaskLayer } from "./OverlayMaskLayer";
import { styleOverlayMask } from "../../lib/bodyPix/overlayMaskStyling";

vi.mock("../../lib/bodyPix/overlayMaskStyling", () => ({
  styleOverlayMask: vi.fn((imageData) => imageData),
}));

describe("OverlayMaskLayer", () => {
  const mockColor = { r: 255, g: 0, b: 0 };
  // Keep a reference to the mocked context to check calls easily
  let mockCtx: any;

  beforeEach(() => {
    vi.clearAllMocks();

    global.URL.createObjectURL = vi.fn(() => "mock-url");
    global.URL.revokeObjectURL = vi.fn();

    mockCtx = {
      clearRect: vi.fn(),
      drawImage: vi.fn(),
      getImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
      createImageData: vi.fn(() => ({ data: new Uint8ClampedArray(4) })),
      putImageData: vi.fn(),
    };

    // Use vi.spyOn for a cleaner mock that Vitest tracks better
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(mockCtx);

    global.Image = class {
      onload: any = null;
      onerror: any = null;
      src: string = "";
      width: number = 100;
      height: number = 100;
      constructor() {
        setTimeout(() => this.onload?.(), 0);
      }
    } as any;
  });

  it("renders a canvas element with provided className", () => {
    // 1. Change: Use container.querySelector or add a testid
    const { container } = render(
      <OverlayMaskLayer 
        frame="test.png" 
        color={mockColor} 
        className="test-class" 
      />
    );
    
    const canvas = container.querySelector('canvas');
    expect(canvas).toBeInTheDocument();
    expect(canvas).toHaveClass("test-class");
  });

  it("clears the canvas when the frame is null", async () => {
    const { rerender } = render(<OverlayMaskLayer frame="test.png" color={mockColor} />);
    
    // 2. Change: Use the mockCtx reference we created in beforeEach
    // Rerender with null frame
    rerender(<OverlayMaskLayer frame={null} color={mockColor} />);
    
    // The second useEffect handles the clearRect
    expect(mockCtx.clearRect).toHaveBeenCalled();
  });

  it("calls styleOverlayMask with correct parameters when image loads", async () => {
    render(<OverlayMaskLayer frame="test.png" color={mockColor} fillOpacity={0.5} />);

    await act(async () => {
      await new Promise((r) => setTimeout(r, 10));
    });

    expect(styleOverlayMask).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ color: mockColor, fillOpacity: 0.5 })
    );
  });
});