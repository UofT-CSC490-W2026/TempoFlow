import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { Providers } from "./Providers";
import React from "react";

// 1. Mock Next-Auth's SessionProvider
// We mock it because we don't want to deal with actual auth providers/network in a unit test
vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="mock-session-provider">{children}</div>
  ),
}));

// 2. Mock your custom Background Processor
// We use a mock to ensure it's called without actually running the background logic
vi.mock("./BackgroundSessionPostProcessor", () => ({
  BackgroundSessionPostProcessor: () => (
    <div data-testid="background-processor" />
  ),
}));

describe("Providers Component", () => {
  it("renders children and the background processor within the SessionProvider", () => {
    render(
      <Providers>
        <div data-testid="child-content">Hello TempoFlow</div>
      </Providers>
    );

    // Verify the Next-Auth provider is wrapping the content
    const sessionProvider = screen.getByTestId("mock-session-provider");
    expect(sessionProvider).toBeInTheDocument();

    // Verify the background logic component is present
    const backgroundProcessor = screen.getByTestId("background-processor");
    expect(backgroundProcessor).toBeInTheDocument();
    expect(sessionProvider).toContainElement(backgroundProcessor);

    // Verify that the children are rendered correctly
    const childContent = screen.getByTestId("child-content");
    expect(childContent).toBeInTheDocument();
    expect(childContent.textContent).toBe("Hello TempoFlow");
    expect(sessionProvider).toContainElement(childContent);
  });

  it("maintains the correct nesting order", () => {
    render(
      <Providers>
        <span>Nested</span>
      </Providers>
    );

    const sessionProvider = screen.getByTestId("mock-session-provider");
    const backgroundProcessor = screen.getByTestId("background-processor");

    expect(sessionProvider.firstChild).toBe(backgroundProcessor);
  });
});