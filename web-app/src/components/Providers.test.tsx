import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { Providers } from "./Providers";
import { usePathname } from "next/navigation";

// ─── 1. MOCK NEXT NAVIGATION ────────────────────────────────────────────────
// This allows us to control what the current URL "looks like" to the component
vi.mock("next/navigation", () => ({
  usePathname: vi.fn(),
}));

// ─── 2. MOCK NEXT-AUTH ──────────────────────────────────────────────────────
vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-session-provider">{children}</div>
  ),
}));

// ─── 3. MOCK BACKGROUND PROCESSOR ───────────────────────────────────────────
vi.mock("./BackgroundSessionPostProcessor", () => ({
  BackgroundSessionPostProcessor: () => (
    <div data-testid="background-processor">Processor Active</div>
  ),
}));

describe("Providers Component", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("renders the background processor when on the /analysis route", () => {
    // Force the pathname to match the condition
    vi.mocked(usePathname).mockReturnValue("/analysis");

    render(
      <Providers>
        <div data-testid="child-content">TempoFlow Analysis</div>
      </Providers>
    );

    // Verify both the Provider and the Processor are present
    expect(screen.getByTestId("mock-session-provider")).toBeInTheDocument();
    expect(screen.getByTestId("background-processor")).toBeInTheDocument();
    expect(screen.getByTestId("child-content")).toHaveTextContent("TempoFlow Analysis");
  });

  it("does NOT render the background processor on other routes", () => {
    // Force the pathname to something else (like home)
    vi.mocked(usePathname).mockReturnValue("/");

    render(
      <Providers>
        <div data-testid="child-content">Home Page</div>
      </Providers>
    );

    expect(screen.getByTestId("mock-session-provider")).toBeInTheDocument();
    
    // Use queryByTestId because it returns null instead of throwing an error when missing
    const processor = screen.queryByTestId("background-processor");
    expect(processor).not.toBeInTheDocument();
    
    expect(screen.getByTestId("child-content")).toBeInTheDocument();
  });

  it("maintains the correct nesting order on /analysis", () => {
    vi.mocked(usePathname).mockReturnValue("/analysis");

    render(
      <Providers>
        <span data-testid="nested-child">Nested Content</span>
      </Providers>
    );

    const provider = screen.getByTestId("mock-session-provider");
    const processor = screen.getByTestId("background-processor");
    const child = screen.getByTestId("nested-child");

    // Ensure the processor is rendered before the children in the DOM tree
    expect(provider).toContainElement(processor);
    expect(provider).toContainElement(child);
    expect(processor.compareDocumentPosition(child)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});