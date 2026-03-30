import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { AppHeader } from "./AppHeader";

describe("AppHeader Component", () => {
  const defaultProps = {
    primaryHref: "/dashboard",
    primaryLabel: "Go to Dashboard",
  };

  it("renders the logo with a link to the homepage", () => {
    render(<AppHeader {...defaultProps} />);
    
    const logoLink = screen.getByRole("link", { name: /tempoflow/i });
    expect(logoLink).toHaveAttribute("href", "/");
    
    const logoImg = screen.getByAltText(/tempoflow/i);
    expect(logoImg).toBeDefined();
  });

  it("renders the primary action button with correct label and href", () => {
    render(<AppHeader {...defaultProps} />);
    
    const primaryLink = screen.getByRole("link", { name: "Go to Dashboard" });
    expect(primaryLink).toHaveAttribute("href", "/dashboard");
    // Verifying the gradient class is present for brand consistency
    expect(primaryLink.className).toContain("from-blue-500");
  });

  it("does not render the secondary link when props are missing", () => {
    render(<AppHeader {...defaultProps} />);
    
    // Use queryByRole since we expect it to be null
    const secondaryLink = screen.queryByRole("link", { name: "Settings" });
    expect(secondaryLink).toBeNull();
  });

  it("renders the secondary link when both secondaryHref and secondaryLabel are provided", () => {
    const propsWithSecondary = {
      ...defaultProps,
      secondaryHref: "/settings",
      secondaryLabel: "Settings",
    };
    
    render(<AppHeader {...propsWithSecondary} />);
    
    const secondaryLink = screen.getByRole("link", { name: "Settings" });
    expect(secondaryLink).toHaveAttribute("href", "/settings");
    expect(secondaryLink.className).toContain("text-slate-600");
  });
});