import { render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { type AppInfo, getAppInfo } from "../lib/ipc/commands";
import { CommandFailure } from "../lib/ipc/errors";
import { SettingsPage } from "./SettingsPage";

vi.mock("../lib/ipc/commands", () => ({ getAppInfo: vi.fn() }));

const getAppInfoMock = vi.mocked(getAppInfo);

beforeEach(() => {
  getAppInfoMock.mockReset();
});

function showWith(info: AppInfo) {
  getAppInfoMock.mockResolvedValue(info);
  render(<SettingsPage />);
}

test("shows a loading state, then the version and the data status", async () => {
  showWith({ version: "0.1.0", data: { state: "ready" } });

  expect(screen.getByRole("status").textContent).toBe(
    "Loading app information…",
  );
  expect(await screen.findByText("0.1.0")).toBeDefined();
  expect(screen.getByText("Ready")).toBeDefined();
  expect(screen.getByRole("heading", { name: "About Liurium" })).toBeDefined();
});

test("explains replaced app data", async () => {
  showWith({ version: "0.1.0", data: { state: "recovered" } });

  expect(
    await screen.findByText(/app data was damaged and has been replaced/),
  ).toBeDefined();
});

test("explains app data that could not be opened", async () => {
  showWith({
    version: "0.1.0",
    data: { state: "failed", error: { kind: "newerVersion" } },
  });

  expect(
    await screen.findByText(/made by a newer version of Liurium/),
  ).toBeDefined();
});

test("a failed command shows an error state with a plain message", async () => {
  getAppInfoMock.mockRejectedValue(
    new CommandFailure("app_info", { kind: "locked" }),
  );
  render(<SettingsPage />);

  const alert = await screen.findByRole("alert");
  expect(alert.textContent).toContain("App information could not be loaded");
  expect(alert.textContent).toContain("Another program is using this data");
});
