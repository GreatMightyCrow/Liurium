import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  addProject,
  type CurrentProject,
  getCurrentProject,
  listProjects,
  locateProject,
  openProject,
  type ProjectEntry,
  type ProjectInfo,
  removeProject,
  renameProject,
} from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import { ProjectsPage } from "./ProjectsPage";

vi.mock("../lib/ipc/commands", () => ({
  getCurrentProject: vi.fn(),
  addProject: vi.fn(),
  listProjects: vi.fn(),
  openProject: vi.fn(),
  renameProject: vi.fn(),
  removeProject: vi.fn(),
  locateProject: vi.fn(),
}));

const mocks = {
  current: vi.mocked(getCurrentProject),
  add: vi.mocked(addProject),
  list: vi.mocked(listProjects),
  open: vi.mocked(openProject),
  rename: vi.mocked(renameProject),
  remove: vi.mocked(removeProject),
  locate: vi.mocked(locateProject),
};

const garden: ProjectInfo = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Garden",
  folder: "D:\\Notes\\Garden",
  readOnly: false,
};

const gardenEntry: ProjectEntry = {
  id: garden.id,
  name: "Garden",
  folder: garden.folder,
  lastOpenedAt: "2026-10-31T14:02:00.000Z",
  status: "open",
};

const work: ProjectEntry = {
  id: "00000000-0000-4000-8000-000000000002",
  name: "Work",
  folder: "D:\\Work",
  lastOpenedAt: "2026-10-30T09:00:00.000Z",
  status: "available",
};

const blog: ProjectEntry = {
  id: "00000000-0000-4000-8000-000000000003",
  name: "Old blog",
  folder: "D:\\Old\\blog",
  lastOpenedAt: null,
  status: "missing",
};

beforeEach(() => {
  for (const mock of Object.values(mocks)) {
    mock.mockReset();
  }
});

function showWith(projects: ProjectEntry[], current: CurrentProject) {
  mocks.list.mockResolvedValue(projects);
  mocks.current.mockResolvedValue(current);
  render(<ProjectsPage />);
}

function showAll() {
  showWith([gardenEntry, work, blog], { state: "open", project: garden });
}

function addButton(): HTMLElement {
  return screen.getByRole("button", { name: "Add project folder" });
}

async function row(name: string): Promise<HTMLElement> {
  const heading = await screen.findByRole("heading", { name });
  const item = heading.closest("li");
  if (item === null) {
    throw new Error(`no row for ${name}`);
  }
  return item;
}

async function chooseFromMenu(project: string, item: string) {
  fireEvent.click(
    await screen.findByRole("button", { name: `Actions for ${project}` }),
  );
  fireEvent.click(await screen.findByRole("menuitem", { name: item }));
}

test("loads, then invites to add the first project", async () => {
  showWith([], { state: "none" });

  expect(screen.getByRole("status").textContent).toBe("Loading projects…");
  expect(
    await screen.findByRole("heading", { name: "No project yet" }),
  ).toBeDefined();
  expect(screen.getByText(/adds a \.liurium folder/)).toBeDefined();
  expect(addButton()).toBeDefined();
});

test("lists the projects in the order Rust gives, with their state in words", async () => {
  showAll();

  const list = await screen.findByRole("list", { name: "Projects" });
  const names = within(list)
    .getAllByRole("heading")
    .map((heading) => heading.textContent);
  expect(names).toEqual(["Garden", "Work", "Old blog"]);

  const open = await row("Garden");
  expect(open.getAttribute("aria-current")).toBe("true");
  expect(open.textContent).toContain("Open");
  expect(open.textContent).toContain("D:\\Notes\\Garden");
  expect(
    within(open)
      .getByText((_, element) => element?.tagName === "TIME")
      .getAttribute("dateTime"),
  ).toBe(gardenEntry.lastOpenedAt);

  const available = await row("Work");
  expect(available.getAttribute("aria-current")).toBeNull();
  expect(available.textContent).not.toContain("Folder not found");

  const missing = await row("Old blog");
  expect(missing.textContent).toContain("Folder not found");
  expect(missing.textContent).toContain("Never opened");
  expect(
    within(missing).getByRole("button", { name: "Locate folder" }),
  ).toBeDefined();
  expect(
    within(missing).queryByRole("button", { name: "Old blog" }),
  ).toBeNull();
});

test("clicking a name opens the project and shows the new list", async () => {
  showAll();
  mocks.open.mockResolvedValue({ ...garden, id: work.id, name: "Work" });

  fireEvent.click(await screen.findByRole("button", { name: "Work" }));

  await waitFor(() => {
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
  expect(mocks.open).toHaveBeenCalledWith(work.id);
});

test("a project that cannot be opened says why below its row", async () => {
  showAll();
  mocks.open.mockRejectedValue(
    new CommandFailure("open_project", { kind: "damaged" }),
  );

  fireEvent.click(await screen.findByRole("button", { name: "Work" }));

  const alert = await within(await row("Work")).findByRole("alert");
  expect(alert.textContent).toBe(
    "“Work” could not be opened. The data is damaged or was not made by Liurium. It was left as it is.",
  );
});

test("a moved folder can be located", async () => {
  showAll();
  mocks.locate.mockResolvedValue({ ...garden, id: blog.id, name: "Old blog" });

  fireEvent.click(await screen.findByRole("button", { name: "Locate folder" }));

  await waitFor(() => {
    expect(mocks.list).toHaveBeenCalledTimes(2);
  });
  expect(mocks.locate).toHaveBeenCalledWith(blog.id);
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a folder with another project is refused when locating", async () => {
  showAll();
  mocks.locate.mockRejectedValue(
    new CommandFailure("locate_project", { kind: "otherProject" }),
  );

  await chooseFromMenu("Old blog", "Locate folder");

  const alert = await within(await row("Old blog")).findByRole("alert");
  expect(alert.textContent).toBe(
    "The folder could not be used for “Old blog”. The folder holds a different project. Nothing was changed.",
  );
});

test("the menu offers what fits each project", async () => {
  showAll();

  const items = async (project: string) => {
    fireEvent.click(
      await screen.findByRole("button", { name: `Actions for ${project}` }),
    );
    const names = (await screen.findAllByRole("menuitem")).map(
      (item) => item.textContent,
    );
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
    await waitFor(() => {
      expect(screen.queryByRole("menu")).toBeNull();
    });
    return names;
  };

  expect(await items("Garden")).toEqual(["Rename…", "Remove from list…"]);
  expect(await items("Work")).toEqual(["Open", "Rename…", "Remove from list…"]);
  expect(await items("Old blog")).toEqual([
    "Locate folder",
    "Remove from list…",
  ]);
});

test("renaming saves the typed name", async () => {
  showAll();
  mocks.rename.mockResolvedValue(undefined);

  await chooseFromMenu("Work", "Rename…");
  const dialog = await screen.findByRole("dialog", { name: "Rename project" });
  const field = within(dialog).getByRole("textbox", { name: "Name" });
  expect((field as HTMLInputElement).value).toBe("Work");
  fireEvent.change(field, { target: { value: "Office" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));

  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(mocks.rename).toHaveBeenCalledWith(work.id, "Office");
  expect(mocks.list).toHaveBeenCalledTimes(2);
});

test("an empty name cannot be saved, and a refused one says why", async () => {
  showAll();
  mocks.rename.mockRejectedValue(
    new CommandFailure("rename_project", { kind: "readOnly" }),
  );

  await chooseFromMenu("Work", "Rename…");
  const dialog = await screen.findByRole("dialog", { name: "Rename project" });
  const field = within(dialog).getByRole("textbox", { name: "Name" });
  const save = screen.getByRole("button", { name: "Save" });
  fireEvent.change(field, { target: { value: "   " } });
  expect(save.hasAttribute("disabled")).toBe(true);
  fireEvent.change(field, { target: { value: "Office" } });
  fireEvent.click(save);

  expect(
    await within(dialog).findByText(/write-protected\. Nothing was changed/),
  ).toBeDefined();
  expect(screen.getByRole("dialog")).toBe(dialog);
});

test("removing asks first and says the folder stays", async () => {
  showAll();
  mocks.remove.mockResolvedValue(undefined);

  await chooseFromMenu("Work", "Remove from list…");
  const dialog = await screen.findByRole("dialog", {
    name: "Remove “Work” from the list?",
  });
  expect(dialog.textContent).toContain(
    "The folder and everything in it stay as they are.",
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(mocks.remove).not.toHaveBeenCalled();

  await chooseFromMenu("Work", "Remove from list…");
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove from list" }),
  );

  await waitFor(() => {
    expect(mocks.remove).toHaveBeenCalledWith(work.id);
  });
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  expect(mocks.list).toHaveBeenCalledTimes(2);
  // The row's menu button may be gone; focus goes to a button that stays.
  await waitFor(() => {
    expect(document.activeElement).toBe(addButton());
  });
});

test("removing the last project focuses the add button of the empty list", async () => {
  showWith([work], { state: "none" });
  mocks.remove.mockResolvedValue(undefined);

  await chooseFromMenu("Work", "Remove from list…");
  mocks.list.mockResolvedValue([]);
  fireEvent.click(
    await screen.findByRole("button", { name: "Remove from list" }),
  );

  expect(
    await screen.findByRole("heading", { name: "No project yet" }),
  ).toBeDefined();
  await waitFor(() => {
    expect(document.activeElement).toBe(addButton());
  });
});

test("says when the open project is write-protected", async () => {
  showWith([gardenEntry], {
    state: "open",
    project: { ...garden, readOnly: true },
  });

  expect(await screen.findByText(/“Garden” is write-protected/)).toBeDefined();
});

test("names the last project that could not be opened at start, and why", async () => {
  showWith([{ ...gardenEntry, status: "missing" }], {
    state: "unavailable",
    id: garden.id,
    name: "Garden",
    error: { kind: "notFound" },
  });

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain(
    "“Garden” could not be opened when Liurium started.",
  );
  expect(alert.textContent).toContain("no longer exists");
});

test("a failed load shows an error state", async () => {
  mocks.list.mockRejectedValue(
    new CommandFailure("list_projects", { kind: "newerVersion" }),
  );
  mocks.current.mockResolvedValue({ state: "none" });
  render(<ProjectsPage />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Projects could not be loaded");
  expect(alert.textContent).toContain("newer version of Liurium");
});

test("adding a folder shows it in the list", async () => {
  showWith([], { state: "none" });
  let finish: (project: ProjectInfo | null) => void = () => undefined;
  mocks.add.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await screen.findByRole("heading", { name: "No project yet" });

  fireEvent.click(addButton());
  const busy = screen.getByRole("button", { name: "Adding…" });
  expect(busy.hasAttribute("disabled")).toBe(true);
  mocks.list.mockResolvedValue([gardenEntry]);
  mocks.current.mockResolvedValue({ state: "open", project: garden });
  finish(garden);

  expect(await screen.findByRole("heading", { name: "Garden" })).toBeDefined();
  expect(addButton().hasAttribute("disabled")).toBe(false);
});

test("a cancelled dialog changes nothing", async () => {
  showWith([], { state: "none" });
  mocks.add.mockResolvedValue(null);
  await screen.findByRole("heading", { name: "No project yet" });

  fireEvent.click(addButton());

  expect(
    await screen.findByRole("button", { name: "Add project folder" }),
  ).toBeDefined();
  expect(screen.getByRole("heading", { name: "No project yet" })).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a folder that cannot be added says why and keeps the list", async () => {
  showAll();
  mocks.add.mockRejectedValue(
    new CommandFailure("add_project", { kind: "readOnly" }),
  );
  await screen.findByRole("heading", { name: "Garden" });

  fireEvent.click(addButton());

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toBe(
    "The folder could not be added. This file or folder is write-protected. Nothing was changed.",
  );
  expect(screen.getByRole("heading", { name: "Garden" })).toBeDefined();
});
