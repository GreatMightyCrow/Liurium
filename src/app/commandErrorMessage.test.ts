import { expect, test } from "vitest";
import type { CommandError } from "../lib/ipc/errors";
import { commandErrorMessage } from "./commandErrorMessage";

const every: CommandError[] = [
  { kind: "notFound" },
  { kind: "alreadyExists" },
  { kind: "changed" },
  { kind: "readOnly" },
  { kind: "locked" },
  { kind: "diskFull" },
  { kind: "damaged" },
  { kind: "newerVersion" },
  { kind: "upgradeFailed" },
  { kind: "invalidPath" },
  { kind: "outsideProject" },
  { kind: "protected" },
  { kind: "brokenLink" },
  { kind: "wrongKind" },
  { kind: "tooLarge", maxBytes: 1_048_576 },
  { kind: "internal" },
];

test("every kind has its own plain sentence", () => {
  const messages = every.map(commandErrorMessage);
  for (const [index, message] of messages.entries()) {
    expect(message, every[index]?.kind).toMatch(/^[A-Z].*\.$/);
    expect(message).not.toMatch(/undefined|NaN|\{|\}/);
  }
  expect(new Set(messages).size).toBe(messages.length);
});

test("the size limit is shown in megabytes", () => {
  expect(commandErrorMessage({ kind: "tooLarge", maxBytes: 16_777_216 })).toBe(
    "The file is larger than 16 MB.",
  );
  expect(commandErrorMessage({ kind: "tooLarge", maxBytes: 1_572_864 })).toBe(
    "The file is larger than 1.5 MB.",
  );
});
