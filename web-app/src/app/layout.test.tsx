import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import RootLayout, { metadata } from "./layout";
import React from "react";

// Mock Google Fonts
vi.mock("next/font/google", () => ({
  Geist: () => ({ variable: "--font-geist-sans" }),
  Geist_Mono: () => ({ variable: "--font-geist-mono" }),
}));

// Mock Providers
vi.mock("../components/Providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-providers">{children}</div>
  ),
}));

describe("RootLayout", () => {
  it("renders children wrapped in the Providers component", () => {
    render(
      <RootLayout>
        <div data-testid="child-content">TempoFlow Content</div>
      </RootLayout>
    );

    expect(screen.getByTestId("child-content")).toBeInTheDocument();
    expect(screen.getByTestId("mock-providers")).toBeInTheDocument();
  });

  it("exports the correct metadata", () => {
    expect(metadata.title).toBe("Tempoflow");
    expect(metadata.description).toContain("AI-powered dance coach");
  });

  it("sets the language attribute to English on the document", () => {
    render(
      <RootLayout>
        <div />
      </RootLayout>
    );
    
    // Check the global document element since JSDOM 
    // hoists the <html> attributes from the component
    const htmlElement = document.documentElement;
    expect(htmlElement).toHaveAttribute("lang", "en");
  });
});