import { invoke, type InvokeArgs } from "@tauri-apps/api/core";
import type { AddOutcome } from "./bindings/AddOutcome";
import type { AppDataInfo } from "./bindings/AppDataInfo";
import type { AppInfo } from "./bindings/AppInfo";
import type { CurrentProject } from "./bindings/CurrentProject";
import type { ConflictChoice } from "./bindings/ConflictChoice";
import type { BacklinkSource } from "./bindings/BacklinkSource";
import type { NoteLink } from "./bindings/NoteLink";
import type { NoteMarks } from "./bindings/NoteMarks";
import type { NoteProperties } from "./bindings/NoteProperties";
import type { Edit as PropertyEdit } from "./bindings/PropertyEdit";
import type { PropertyField } from "./bindings/PropertyField";
import type { PropertyKind } from "./bindings/PropertyKind";
import type { PropertyKindChoice } from "./bindings/PropertyKindChoice";
import type { Value as PropertyValue } from "./bindings/PropertyValue";
import type { TagNotes } from "./bindings/TagNotes";
import type { NotesView } from "./bindings/NotesView";
import type { CloseChoice } from "./bindings/CloseChoice";
import type { CloseOutcome } from "./bindings/CloseOutcome";
import type { CloseQuestion } from "./bindings/CloseQuestion";
import type { CloseReason } from "./bindings/CloseReason";
import type { NoteCheck } from "./bindings/NoteCheck";
import type { OpenedNote } from "./bindings/OpenedNote";
import type { SaveState } from "./bindings/SaveState";
import type { ProjectEntry } from "./bindings/ProjectEntry";
import type { ProjectInfo } from "./bindings/ProjectInfo";
import type { ProjectStatus } from "./bindings/ProjectStatus";
import type { Settings } from "./bindings/Settings";
import type { SettingsView } from "./bindings/SettingsView";
import { toCommandFailure } from "./errors";

export type {
  AddOutcome,
  AppDataInfo,
  AppInfo,
  ConflictChoice,
  CurrentProject,
  NoteLink,
  NoteMarks,
  NoteProperties,
  PropertyEdit,
  PropertyField,
  PropertyKind,
  PropertyKindChoice,
  PropertyValue,
  NotesView,
  CloseChoice,
  CloseOutcome,
  CloseQuestion,
  CloseReason,
  NoteCheck,
  OpenedNote,
  ProjectEntry,
  ProjectInfo,
  ProjectStatus,
  SaveState,
  Settings,
  SettingsView,
  TagNotes,
};
export type { DataStatus } from "./bindings/DataStatus";
export type { FrameStyle } from "./bindings/FrameStyle";
export type { Mode } from "./bindings/Mode";
export type { BacklinkLine } from "./bindings/BacklinkLine";
export type { BacklinkSource } from "./bindings/BacklinkSource";
export type { LinkCandidate } from "./bindings/LinkCandidate";
export type { LinkTarget } from "./bindings/LinkTarget";
export type { ImageSource } from "./bindings/ImageSource";
export type { NoteImage } from "./bindings/NoteImage";
export type { NoteMath } from "./bindings/NoteMath";
export type { NoteEntry } from "./bindings/NoteEntry";
export type { NoteLineEnding } from "./bindings/NoteLineEnding";
export type { NoteReadOnly } from "./bindings/NoteReadOnly";
export type { NoteTag } from "./bindings/NoteTag";
export type { SettingKey } from "./bindings/SettingKey";
export type { SkippedNotes } from "./bindings/SkippedNotes";
export type { StartWith } from "./bindings/StartWith";
export type { SyncTool } from "./bindings/SyncTool";
export type { ThemeChoice } from "./bindings/ThemeChoice";
export type { Zoom } from "./bindings/Zoom";

// One function per Rust command (src-tauri/src/commands). Each command also needs
// its permission in src-tauri/capabilities/default.json (Security Model, ADR-0018).
// A failed command rejects with a CommandFailure.

export function getAppInfo(): Promise<AppInfo> {
  return call("app_info");
}

/** The open project; on the first call, Rust reopens the one from the last run. */
export function getCurrentProject(): Promise<CurrentProject> {
  return call("current_project");
}

/** Rust shows the folder dialog; `null` when the user cancels it. A copy of a listed
 *  project is not added: Rust keeps it for `separateProjectCopy` (M2-011). */
export function addProject(): Promise<AddOutcome | null> {
  return call("add_project");
}

/** Gives the copy found by the last `addProject` its own identity and opens it. */
export function separateProjectCopy(): Promise<ProjectInfo> {
  return call("separate_project_copy");
}

/** All known projects, the most recently opened first. */
export function listProjects(): Promise<ProjectEntry[]> {
  return call("list_projects");
}

/** Makes the project the open one; the one open before closes. */
export function openProject(id: string): Promise<ProjectInfo> {
  return call("open_project", { id });
}

/** Renames the project in its folder, so the name travels with it. */
export function renameProject(id: string, name: string): Promise<void> {
  return call("rename_project", { id, name });
}

/** Removes the project from the list; its folder stays as it is. */
export function removeProject(id: string): Promise<void> {
  return call("remove_project", { id });
}

/** Rust shows the folder dialog to find a moved project; `null` when cancelled. */
export function locateProject(id: string): Promise<ProjectInfo | null> {
  return call("locate_project", { id });
}

export function getSettings(): Promise<SettingsView> {
  return call("get_settings");
}

/** Saves, then Rust changes the window's icon, background, mode, and zoom at once. */
export function updateSettings(settings: Settings): Promise<SettingsView> {
  return call("update_settings", { settings });
}

/** Closes Liurium and starts it again, so a new window frame applies. */
export function restartApp(): Promise<void> {
  return call("restart_app");
}

/** Where Liurium keeps its own data, its backup copies, and the sync warnings. */
export function getAppDataInfo(): Promise<AppDataInfo> {
  return call("app_data_info");
}

/** Rust opens the app data folder in Explorer; the page cannot name another path. */
export function openAppDataFolder(): Promise<void> {
  return call("open_app_data_folder");
}

/** Deletes all but the newest backup copies; ask the user first. */
export function pruneBackups(): Promise<AppDataInfo> {
  return call("prune_backups");
}

/** Every project shows its sync-folder warning once more. */
export function resetSyncWarnings(): Promise<AppDataInfo> {
  return call("reset_sync_warnings");
}

/** The notes of the open project, once Rust has walked its folder. No content. */
export function listNotes(): Promise<NotesView> {
  return call("list_notes");
}

/** Opens a note of the open project by its path; Rust checks the path. With `unify`,
 *  a note with mixed line endings is first made uniform (ask the user before). */
export function openNote(path: string, unify = false): Promise<OpenedNote> {
  return call("open_note", { path, unify });
}

/** Hands Rust the editor's text; with `save`, Rust writes it. `revision` is the one
 *  the text is based on: text from before a reload cannot overwrite the file. */
export function updateNote(
  path: string,
  text: string,
  save: boolean,
  revision: number,
): Promise<SaveState> {
  return call("update_note", { path, text, save, revision });
}

/** Waits until something changed outside Liurium, or 30 seconds passed. Returns the
 *  count of changes, nothing else (M3-008). */
export function waitNoteChanges(seen: number): Promise<number> {
  return call("wait_note_changes", { seen });
}

/** Looks at the disk now: the window got focus. */
export function checkNoteChanges(): Promise<void> {
  return call("check_note_changes");
}

/** Looks at the open note's file and brings Rust's state in line with it. */
export function reconcileNote(path: string): Promise<NoteCheck> {
  return call("reconcile_note", { path });
}

/** The user's answer after the note changed outside Liurium. */
export function resolveNoteConflict(
  path: string,
  choice: ConflictChoice,
): Promise<OpenedNote> {
  return call("resolve_note_conflict", { path, choice });
}

/** Leaves the note; refused while its text is not saved, unless the user chose to
 *  drop that text (`discard`). */
export function closeNote(path: string, discard = false): Promise<void> {
  return call("close_note", { path, discard });
}

/** Waits until the window wants to close and a note could not be saved, or 30 seconds
 *  passed (M3-016). */
export function waitCloseQuestion(): Promise<CloseQuestion | null> {
  return call("wait_close_question");
}

/** Answers that question. Without one waiting, it does nothing. */
export function answerCloseQuestion(
  choice: CloseChoice,
): Promise<CloseOutcome> {
  return call("answer_close_question", { choice });
}

/** Opens an address in the browser or mail program; Rust checks it first (M3-012). */
export function openExternalLink(address: string): Promise<void> {
  return call("open_external_link", { address });
}

/** Creates an empty note in a folder ("" for the top). Returns its path. */
export function createNote(folder: string, name: string): Promise<string> {
  return call("create_note", { folder, name });
}

/** Creates a folder inside another ("" for the top). Returns its path. */
export function createFolder(parent: string, name: string): Promise<string> {
  return call("create_folder", { parent, name });
}

/** Renames a note or folder in place. Returns its new path. */
export function renameEntry(path: string, name: string): Promise<string> {
  return call("rename_entry", { path, name });
}

/** Moves a note or folder into a folder ("" for the top). Returns its new path. */
export function moveEntry(path: string, folder: string): Promise<string> {
  return call("move_entry", { path, folder });
}

/** Moves a note or folder into the project's trash (.liurium/trash). */
export function trashEntry(path: string): Promise<void> {
  return call("trash_entry", { path });
}

/** Every link and tag in the editor's text, with its place (and where a link
 *  leads). Rust only parses the text; nothing is written. */
export function noteLinks(path: string, text: string): Promise<NoteMarks> {
  return call("note_links", { path, text });
}

/** The notes that link to this one, with the line around each link. */
export function backlinksOf(path: string): Promise<BacklinkSource[]> {
  return call("backlinks", { path });
}

/** The note's text after one property edit. Rust only changes the text; it saves
 *  through the editor, like typing. */
export function editProperty(
  text: string,
  edit: PropertyEdit,
): Promise<string> {
  return call("edit_property", { text, edit });
}

/** The kinds chosen for property names in the open project. */
export function propertyKinds(): Promise<PropertyKindChoice[]> {
  return call("property_kinds");
}

/** Chooses a kind for a property name; `null` follows the value again. */
export function setPropertyKind(
  name: string,
  kind: PropertyKind | null,
): Promise<void> {
  return call("set_property_kind", { name, kind });
}

/** Every tag of the open project with the notes that carry it. */
export function projectTags(): Promise<TagNotes[]> {
  return call("project_tags");
}

async function call<T>(command: string, args?: InvokeArgs): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (reason) {
    throw toCommandFailure(command, reason);
  }
}
