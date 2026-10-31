import { expect, test } from "vitest";
import { isCommandError, toCommandFailure } from "./errors";

test("known kinds are command errors", () => {
  expect(isCommandError({ kind: "changed" })).toBe(true);
  expect(isCommandError({ kind: "internal" })).toBe(true);
  expect(isCommandError({ kind: "tooLarge", maxBytes: 5 })).toBe(true);
});

test("anything else is not a command error", () => {
  for (const value of [
    undefined,
    null,
    "changed",
    42,
    {},
    { kind: 1 },
    { kind: "somethingNew" },
    { kind: "toString" },
    { kind: "tooLarge" },
    { kind: "tooLarge", maxBytes: "5" },
  ]) {
    expect(isCommandError(value), JSON.stringify(value)).toBe(false);
  }
});

test("a failure keeps the command and the typed error", () => {
  const failure = toCommandFailure("app_info", { kind: "locked" });

  expect(failure.command).toBe("app_info");
  expect(failure.error).toEqual({ kind: "locked" });
  expect(failure.message).toBe("Command app_info failed: locked");
  expect(failure.reason).toBeUndefined();
});
