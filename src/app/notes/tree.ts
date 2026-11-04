import type { NoteEntry } from "../../lib/ipc/commands";

// The notes tree (M3-004): folders that hold notes somewhere below, plus empty
// folders, built from the walk's paths. Folders come first, then notes, each by
// name without case, as in Explorer.

export interface FolderNode {
  kind: "folder";
  /** Below the project; empty for the top. */
  path: string;
  name: string;
  folders: FolderNode[];
  notes: NoteNode[];
}

export interface NoteNode {
  kind: "note";
  path: string;
  name: string;
}

export type TreeNode = FolderNode | NoteNode;

export function parentOf(path: string): string {
  const cut = path.lastIndexOf("/");
  return cut < 0 ? "" : path.slice(0, cut);
}

export function nameOf(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

/** Whether `path` is `folder` or lies inside it, without case as on Windows. */
export function isInside(path: string, folder: string): boolean {
  if (folder === "") {
    return true;
  }
  const a = path.toLowerCase();
  const b = folder.toLowerCase();
  return a === b || a.startsWith(`${b}/`);
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, "en", { sensitivity: "base" }) ||
  a.name.localeCompare(b.name, "en");

export function buildTree(
  notes: readonly NoteEntry[],
  emptyFolders: readonly string[],
): FolderNode {
  const top: FolderNode = {
    kind: "folder",
    path: "",
    name: "",
    folders: [],
    notes: [],
  };
  const folders = new Map<string, FolderNode>([["", top]]);
  const folder = (path: string): FolderNode => {
    const known = folders.get(path);
    if (known !== undefined) {
      return known;
    }
    const node: FolderNode = {
      kind: "folder",
      path,
      name: nameOf(path),
      folders: [],
      notes: [],
    };
    folders.set(path, node);
    folder(parentOf(path)).folders.push(node);
    return node;
  };
  for (const path of emptyFolders) {
    folder(path);
  }
  for (const note of notes) {
    folder(parentOf(note.path)).notes.push({
      kind: "note",
      path: note.path,
      name: nameOf(note.path),
    });
  }
  for (const node of folders.values()) {
    node.folders.sort(byName);
    node.notes.sort(byName);
  }
  return top;
}

export interface Row {
  node: TreeNode;
  /** 1 at the top of the project. */
  level: number;
}

/** The rows shown with these folders open, in order. */
export function visibleRows(
  top: FolderNode,
  expanded: ReadonlySet<string>,
): Row[] {
  const rows: Row[] = [];
  const walk = (folder: FolderNode, level: number) => {
    for (const child of folder.folders) {
      rows.push({ node: child, level });
      if (expanded.has(child.path)) {
        walk(child, level + 1);
      }
    }
    for (const note of folder.notes) {
      rows.push({ node: note, level });
    }
  };
  walk(top, 1);
  return rows;
}

/** Every folder of the tree, top first, for "Move to…". */
export function allFolders(top: FolderNode): string[] {
  const paths: string[] = [""];
  const walk = (folder: FolderNode) => {
    for (const child of folder.folders) {
      paths.push(child.path);
      walk(child);
    }
  };
  walk(top);
  return paths;
}

/** The folders above a path, so it can be shown open. */
export function ancestors(path: string): string[] {
  const parts = path.split("/");
  return parts.slice(0, -1).map((_, i) => parts.slice(0, i + 1).join("/"));
}
