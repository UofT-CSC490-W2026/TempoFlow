import { describe, it, expect, vi } from "vitest";
import { authOptions } from "@/lib/auth-options";

// 1. Mock dependencies before they are used in authOptions
vi.mock("@next-auth/dynamodb-adapter", () => ({
  DynamoDBAdapter: vi.fn(() => ({ name: "mock-adapter" })),
}));

vi.mock("next-auth/providers/google", () => ({
  default: vi.fn(() => ({ id: "google", name: "Google" })),
}));

vi.mock("@/lib/dynamodb", () => ({
  docClient: {},
}));

// 2. Set environment variables for non-null assertions (!)
process.env.GOOGLE_CLIENT_ID = "test-id";
process.env.GOOGLE_CLIENT_SECRET = "test-secret";
process.env.NEXTAUTH_SECRET = "test-auth-secret";

describe("NextAuth Configuration", () => {
  it("should be configured with the DynamoDB adapter and JWT strategy", () => {
    expect(authOptions.adapter).toBeDefined();
    expect(authOptions.session?.strategy).toBe("jwt");
  });

  it("should point to the custom login page", () => {
    expect(authOptions.pages?.signIn).toBe("/login");
  });

  describe("Callbacks", () => {
    it("jwt() should persist user.id to the token during sign-in", async () => {
      const mockToken = { email: "dancer@tempoflow.com" };
      const mockUser = { id: "user_vibe_123" };

      // We cast to 'any' to avoid deep NextAuth interface mocking
      const result = await (authOptions.callbacks?.jwt as any)({
        token: mockToken,
        user: mockUser,
      });

      expect(result.id).toBe("user_vibe_123");
    });

    it("session() should move the id from token to the session object", async () => {
      const mockSession = { user: { email: "dancer@tempoflow.com" } };
      const mockToken = { id: "user_vibe_123" };

      const result = await (authOptions.callbacks?.session as any)({
        session: mockSession,
        token: mockToken,
      });

      expect(result.user.id).toBe("user_vibe_123");
    });
  });
});