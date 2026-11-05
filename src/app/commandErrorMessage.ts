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
  linkRefused: () => "Liurium does not open this kind of address.",
  linkNotOpened: () =>
    "Windows could not open this address. Check that a browser or mail program is set up.",
  notFound: () => "The file or folder no longer exists.",
  alreadyExists: () => "A file or folder with this name already exists.",
  changed: () => "The file was changed outside Liurium. Nothing was saved.",
  readOnly: () =>
    "This file or folder is write-protected. Nothing was changed.",
  locked: () => "Another program is using this data. Close it and try again.",
  diskFull: () => "The disk is full. Free some space and try again.",
  damaged: () =>
    "The data is damaged or was not made by Liurium. It was left as it is.",
  newerVersion: () =>
    "This data was made by a newer version of Liurium. Update Liurium to open it.",
  upgradeFailed: () =>
    "The data could not be updated for this version of Liurium. It was left unchanged.",
  invalidPath: () => "This name or path is not allowed on Windows.",
  skippedName: () =>
    "Liurium leaves out names that start with a dot and folders such as node_modules or build, so this would not show up. Choose another name.",
  isLink: () =>
    "This is a link to another place. Liurium does not rename, move, or delete links; use Explorer for that.",
  notUtf8: () =>
    "Liurium can open only UTF-8 text files. This file uses another encoding or is not text.",
  unsaved: () => "This note has changes that are not saved yet.",
  invalidTag: () =>
    "A tag can hold letters, digits, _, -, and /, and needs at least one that is not a digit.",
  propertyRefused: () =>
    "Liurium could not make this change without risk to the rest of the note. Check the value, or use Edit as text.",
  outsideProject: () => "This path leads outside the project.",
  protected: () =>
    "This folder is managed by Liurium or Git and cannot be changed here.",
  brokenLink: () =>
    "This link points to a file or folder that no longer exists.",
  wrongKind: () =>
    "A folder was found where a file was expected, or the other way round.",
  tooLarge: ({ maxBytes }) =>
    `The file is larger than ${megabytes.format(maxBytes / 1_048_576)}.`,
  unsuitableFolder: () =>
    "Choose a folder of its own, not a whole drive or a folder inside .liurium or .git.",
  otherProject: () =>
    "The folder holds a different project. Nothing was changed.",
  duplicateProject: () =>
    "Another folder already holds this project, so this one looks like a copy. Nothing was changed.",
  noProject: () => "This folder holds no Liurium project. Nothing was changed.",
  invalidName: () => "Use a name with 1 to 200 characters and no line breaks.",
  internal: () =>
    "Something went wrong inside Liurium. Try again, and restart Liurium if it keeps happening.",
};

export function commandErrorMessage(error: CommandError): string {
  const message = messages[error.kind] as (error: CommandError) => string;
  return message(error);
}
