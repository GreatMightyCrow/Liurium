import type { CommandError } from "./bindings/CommandError";

export type { CommandError };

// Every kind once. Typed against the generated union, so a kind added or removed in
// Rust (src-tauri/src/commands/error.rs) fails the typecheck here.
const kinds: Record<CommandError["kind"], true> = {
  notFound: true,
  alreadyExists: true,
  changed: true,
  readOnly: true,
  locked: true,
  diskFull: true,
  damaged: true,
  newerVersion: true,
  upgradeFailed: true,
  invalidPath: true,
  outsideProject: true,
  protected: true,
  brokenLink: true,
  wrongKind: true,
  tooLarge: true,
  internal: true,
};
const knownKinds = new Set<string>(Object.keys(kinds));

export function isCommandError(value: unknown): value is CommandError {
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    return false;
  }
  const { kind } = value;
  if (typeof kind !== "string" || !knownKinds.has(kind)) {
    return false;
  }
  return (
    kind !== "tooLarge" ||
    ("maxBytes" in value && typeof value.maxBytes === "number")
  );
}

/** A command failed; `error` says why in a form the UI can explain. */
export class CommandFailure extends Error {
  readonly command: string;
  readonly error: CommandError;
  /** The original rejection when it was not a CommandError, for debugging. */
  readonly reason: unknown;

  constructor(command: string, error: CommandError, reason?: unknown) {
    super(`Command ${command} failed: ${error.kind}`);
    this.name = "CommandFailure";
    this.command = command;
    this.error = error;
    this.reason = reason;
  }
}

// Rust rejects with a CommandError. Tauri itself rejects with a plain string, for
// example when a permission is missing; that becomes `internal`, with the original
// kept as `reason`.
export function toCommandFailure(
  command: string,
  reason: unknown,
): CommandFailure {
  return isCommandError(reason)
    ? new CommandFailure(command, reason)
    : new CommandFailure(command, { kind: "internal" }, reason);
}
