import { afterEach, describe, expect, it } from "vitest";
import { testRoutesEnabled } from "@/lib/security/test-routes";

const original = process.env.LIBI_ENABLE_TEST_ROUTES;

afterEach(() => {
  if (original === undefined) delete process.env.LIBI_ENABLE_TEST_ROUTES;
  else process.env.LIBI_ENABLE_TEST_ROUTES = original;
});

describe("testRoutesEnabled", () => {
  it("is false when the flag is unset", () => {
    delete process.env.LIBI_ENABLE_TEST_ROUTES;
    expect(testRoutesEnabled()).toBe(false);
  });

  it("is false when the flag is any value other than exactly '1'", () => {
    for (const v of ["", "0", "true", "yes", "2"]) {
      process.env.LIBI_ENABLE_TEST_ROUTES = v;
      expect(testRoutesEnabled()).toBe(false);
    }
  });

  it("is true only when the flag is exactly '1'", () => {
    process.env.LIBI_ENABLE_TEST_ROUTES = "1";
    expect(testRoutesEnabled()).toBe(true);
  });
});
