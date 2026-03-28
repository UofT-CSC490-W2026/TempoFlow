import { render } from "@testing-library/react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import EbsViewerPage from "./page";
import { redirect } from "next/navigation";

// 1. Mock next/navigation
vi.mock("next/navigation", () => ({
  redirect: vi.fn(),
}));

describe("EbsViewerPage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /upload immediately upon rendering", () => {
    render(<EbsViewerPage />);

    expect(redirect).toHaveBeenCalledWith("/upload");
    
    expect(redirect).toHaveBeenCalledTimes(1);
  });
});