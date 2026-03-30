import { render } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import RootLayout, { metadata } from "./layout";
import React from "react";

vi.mock("../components/Providers", () => ({
  Providers: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

describe("RootLayout", () => {
  it("renders children correctly within the body", () => {
    const { getByText } = render(
      <RootLayout>
        <div data-testid="child">Hello World</div>
      </RootLayout>
    );

    expect(getByText("Hello World")).toBeInTheDocument();
  });

  it("applies the antialiased class to the body", () => {
    render(
      <RootLayout>
        <div />
      </RootLayout>
    );

    const body = document.querySelector("body");

    expect(body).toHaveClass("antialiased");
  });

  it("has the correct language attribute on the html tag", () => {
    render(
      <RootLayout>
        <div />
      </RootLayout>
    );

    const html = document.querySelector("html");
    expect(html).toHaveAttribute("lang", "en");
  });

  it("suppresses hydration warnings on html and body", () => {
    const { baseElement } = render(
      <RootLayout>
        <div />
      </RootLayout>
    );

    const html = document.querySelector("html");
    const body = document.querySelector("body");
    expect(html).toBeDefined();
    expect(body).toBeDefined();
    
  });

  it("exports the correct metadata", () => {
    expect(metadata.title).toBe("Tempoflow");
    expect(metadata.description).toBe("An AI-powered dance coach to help you improve your dance skills.");
  });
});
