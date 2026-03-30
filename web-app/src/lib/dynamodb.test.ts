import { describe, it, expect, vi } from "vitest";

// 1. Define the mocks at the top level
vi.mock("@aws-sdk/client-dynamodb", () => {
  return {
    DynamoDBClient: vi.fn(function() {
      return { send: vi.fn() };
    }),
  };
});

vi.mock("@aws-sdk/lib-dynamodb", () => {
  return {
    DynamoDBDocument: {
      from: vi.fn().mockReturnValue({
        get: vi.fn(),
        put: vi.fn(),
      }),
    },
  };
});

// 2. Import the SDKs here to access the mocked versions in our expectations
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocument } from "@aws-sdk/lib-dynamodb";

// 3. Set Env Vars before importing the module
process.env.AWS_REGION = "us-east-1";
process.env.AWS_ACCESS_KEY_ID = "test-key";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret";

describe("DynamoDB Configuration", () => {
  // NOTICE: We do NOT use vi.clearAllMocks() in beforeEach here
  // because the initialization happens only once when the module is first imported.

  it("should initialize the DynamoDBClient and DocumentClient on load", async () => {
    // 4. Import the docClient inside the test or keep the top-level import
    // If you import it at the top, the calls happen immediately.
    await import("./dynamodb");

    // Check if the constructor was called during module load
    expect(DynamoDBClient).toHaveBeenCalled();

    // Check if TempoFlow marshalling options were applied
    expect(DynamoDBDocument.from).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({
        marshallOptions: {
          removeUndefinedValues: true,
          convertEmptyValues: true,
        },
      })
    );
  });

  it("should export a functional instance", async () => {
    const { docClient } = await import("./dynamodb");
    expect(docClient).toBeDefined();
    expect(typeof docClient.put).toBe("function");
  });
});