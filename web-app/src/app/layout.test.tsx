import React from "react";
import { render, screen, cleanup } from "@testing-library/react";
import { describe, it, expect, vi, afterEach } from "vitest";
import RootLayout, { metadata } from "./layout";

// --- Mocks ---
vi.mock("../components/Providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-providers">{children}</div>
  ),
}));

vi.mock("./globals.css", () => ({}));

vi.mock("../components/Providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("RootLayout", () => {
  afterEach(() => {
    cleanup();
    // Reset attributes on the global document between tests
    document.documentElement.lang = "";
    document.body.className = "";
  });

  it("exports the correct metadata for Tempoflow", () => {
    expect(metadata.title).toBe("Tempoflow");
    expect(metadata.description).toContain("AI-powered dance coach");
  });

  it("renders children inside the Providers wrapper", () => {
    render(
      <RootLayout>
        <div data-testid="test-child">Dance Content</div>
      </RootLayout>
    );

    expect(screen.getByTestId("mock-providers")).toBeInTheDocument();
    expect(screen.getByTestId("test-child")).toHaveTextContent("Dance Content");
  });

  it("applies the antialiased class to the global body tag", () => {
    render(
      <RootLayout>
        <div />
      </RootLayout>
    );

    // Look at the REAL document body, not the test container
    expect(document.body).toHaveClass("antialiased");
  });

  it("sets the correct language attribute on the global html tag", () => {
    render(
      <RootLayout>
        <div />
      </RootLayout>
    );

    // Look at the REAL document element (html)
    expect(document.documentElement).toHaveAttribute("lang", "en");
  });
});