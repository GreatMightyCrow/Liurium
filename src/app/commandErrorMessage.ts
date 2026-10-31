import type { CommandError } from "../lib/ipc/errors";

const megabytes = new Intl.NumberFormat("en", {
  style: "unit",
  unit: "megabyte",
  maximumFractionDigits: 1,
});

// One plain-language sentence per error kind, for error states and notifications.
// The record must name every kind, so a new kind from Rust fails the typecheck.
const messages: {
  [Kind in CommandError["kind"]]: (
    error: Extract<CommandError, { kind: Kind }>,
  ) => string;
} = {
  notFound: () => "The file or folder no longer exists.",
  alreadyExists: () => "A file or folder with this name already exists.",
  changed: () => "The file was changed outside Liurium. Nothing was saved.",
  readOnly: () => "The file is read-only. Nothing was saved.",
  locked: () => "Another program is using this data. Close it and try again.",
  diskFull: () => "The disk is full. Free some space and try again.",
  damaged: () =>
    "The data is damaged or was not made by Liurium. It was left as it is.",
  newerVersion: () =>
    "This data was made by a newer version of Liurium. Update Liurium to open it.",
  upgradeFailed: () =>
    "The data could not be updated for this version of Liurium. It was left unchanged.",
  invalidPath: () => "This name or path is not allowed on Windows.",
  outsideProject: () => "This path leads outside the project.",
  protected: () =>
    "This folder is managed by Liurium or Git and cannot be changed here.",
  brokenLink: () =>
    "This link points to a file or folder that no longer exists.",
  wrongKind: () =>
    "A folder was found where a file was expected, or the other way round.",
  tooLarge: ({ maxBytes }) =>
    `The file is larger than ${megabytes.format(maxBytes / 1_048_576)}.`,
  internal: () =>
    "Something went wrong inside Liurium. Try again, and restart Liurium if it keeps happening.",
};

export function commandErrorMessage(error: CommandError): string {
  const message = messages[error.kind] as (error: CommandError) => string;
  return message(error);
}
