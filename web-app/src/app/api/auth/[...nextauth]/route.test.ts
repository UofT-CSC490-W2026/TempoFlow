import { describe, it, expect, vi } from "vitest";

// 1. Mock NextAuth itself
// We use a factory function because NextAuth is a default export 
// that returns the handler function.
const mockHandler = vi.fn();
vi.mock("next-auth", () => ({
  default: vi.fn(() => mockHandler),
}));

// 2. Mock your authOptions
vi.mock("@/lib/auth-options", () => ({
  authOptions: {
    providers: [],
    secret: "test-secret",
  },
}));

describe("NextAuth Route Handler", () => {
  it("should initialize NextAuth with the imported authOptions", async () => {
    // We import the route file dynamically to trigger the initialization
    await import("./route");
    
    // Grab the mocked NextAuth constructor
    const NextAuth = (await import("next-auth")).default;
    const { authOptions } = await import("@/lib/auth-options");

    // Verify that NextAuth was called once with our specific config
    expect(NextAuth).toHaveBeenCalledWith(authOptions);
    expect(NextAuth).toHaveBeenCalledTimes(1);
  });

  it("should export the same handler for both GET and POST", async () => {
    const { GET, POST } = await import("./route");

    expect(GET).toBe(POST);
    expect(GET).toBeDefined();
  });
});