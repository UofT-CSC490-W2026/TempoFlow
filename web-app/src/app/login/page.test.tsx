import { render, screen, fireEvent } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import React from "react";
// 1. Import the real-looking names first
import { signIn } from "next-auth/react";
import LoginPage from "./page";

// 2. Mock next-auth/react
vi.mock("next-auth/react", () => ({
  signIn: vi.fn(),
}));

// 3. Mock next/image
vi.mock("next/image", () => ({
  default: (props: any) => {
    // eslint-disable-next-line @next/next/no-img-element
    return <img {...props} />;
  },
}));

describe("LoginPage", () => {
  it("renders the login UI correctly", () => {
    render(<LoginPage />);
    expect(screen.getByText(/Welcome/i)).toBeInTheDocument();
    expect(screen.getByText(/Continue with Google/i)).toBeInTheDocument();
  });

  it("calls signIn with 'google' and correct callbackUrl when button is clicked", () => {
    render(<LoginPage />);

    const googleButton = screen.getByRole("button", { name: /continue with google/i });
    fireEvent.click(googleButton);

    // Because we mocked the module, the 'signIn' we imported at the top 
    // is now the vitest spy.
    expect(signIn).toHaveBeenCalledWith("google", { 
      callbackUrl: "/dashboard" 
    });
    expect(signIn).toHaveBeenCalledTimes(1);
  });

  it("renders the TempoFlow logo in multiple places", () => {
    render(<LoginPage />);
    const logos = screen.getAllByAltText("TempoFlow");
    expect(logos.length).toBeGreaterThanOrEqual(2);
  });
});