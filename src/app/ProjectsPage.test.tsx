import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import {
  addProject,
  type CurrentProject,
  getCurrentProject,
  type ProjectInfo,
} from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import { ProjectsPage } from "./ProjectsPage";

vi.mock("../lib/ipc/commands", () => ({
  getCurrentProject: vi.fn(),
  addProject: vi.fn(),
}));

const getCurrentProjectMock = vi.mocked(getCurrentProject);
const addProjectMock = vi.mocked(addProject);

const garden: ProjectInfo = {
  id: "00000000-0000-4000-8000-000000000001",
  name: "Garden",
  folder: "D:\\Notes\\Garden",
  readOnly: false,
};

beforeEach(() => {
  getCurrentProjectMock.mockReset();
  addProjectMock.mockReset();
});

function showWith(current: CurrentProject) {
  getCurrentProjectMock.mockResolvedValue(current);
  render(<ProjectsPage />);
}

function addButton(): HTMLElement {
  return screen.getByRole("button", { name: "Add project folder" });
}

test("loads, then invites to add the first project", async () => {
  showWith({ state: "none" });

  expect(screen.getByRole("status").textContent).toBe("Loading projects…");
  expect(
    await screen.findByRole("heading", { name: "No project yet" }),
  ).toBeDefined();
  expect(screen.getByText(/adds a \.liurium folder/)).toBeDefined();
  expect(addButton()).toBeDefined();
});

test("shows the open project with its folder", async () => {
  showWith({ state: "open", project: garden });

  expect(await screen.findByRole("heading", { name: "Garden" })).toBeDefined();
  expect(screen.getByText("D:\\Notes\\Garden")).toBeDefined();
  expect(screen.queryByText(/write-protected/)).toBeNull();
});

test("says when the open project is write-protected", async () => {
  showWith({ state: "open", project: { ...garden, readOnly: true } });

  expect(
    await screen.findByText(/This folder is write-protected/),
  ).toBeDefined();
});

test("names the last project that could not be opened, and why", async () => {
  showWith({
    state: "unavailable",
    name: "Garden",
    error: { kind: "notFound" },
  });

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("“Garden” could not be opened");
  expect(alert.textContent).toContain("no longer exists");
  expect(addButton()).toBeDefined();
});

test("a failed load shows an error state", async () => {
  getCurrentProjectMock.mockRejectedValue(
    new CommandFailure("current_project", { kind: "newerVersion" }),
  );
  render(<ProjectsPage />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("Projects could not be loaded");
  expect(alert.textContent).toContain("newer version of Liurium");
});

test("adding a folder opens it as the current project", async () => {
  showWith({ state: "none" });
  let finish: (project: ProjectInfo | null) => void = () => undefined;
  addProjectMock.mockReturnValue(
    new Promise((resolve) => {
      finish = resolve;
    }),
  );
  await screen.findByRole("heading", { name: "No project yet" });

  fireEvent.click(addButton());
  const busy = screen.getByRole("button", { name: "Adding…" });
  expect(busy.hasAttribute("disabled")).toBe(true);
  finish(garden);

  expect(await screen.findByRole("heading", { name: "Garden" })).toBeDefined();
  expect(addButton().hasAttribute("disabled")).toBe(false);
});

test("a cancelled dialog changes nothing", async () => {
  showWith({ state: "none" });
  addProjectMock.mockResolvedValue(null);
  await screen.findByRole("heading", { name: "No project yet" });

  fireEvent.click(addButton());

  expect(
    await screen.findByRole("button", { name: "Add project folder" }),
  ).toBeDefined();
  expect(screen.getByRole("heading", { name: "No project yet" })).toBeDefined();
  expect(screen.queryByRole("alert")).toBeNull();
});

test("a folder that cannot be added says why and keeps the open project", async () => {
  showWith({ state: "open", project: garden });
  addProjectMock.mockRejectedValue(
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
