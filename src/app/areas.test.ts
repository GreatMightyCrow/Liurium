import { expect, test } from "vitest";
import { areas } from "./areas";

test("every area has its own path and label", () => {
  expect(new Set(areas.map((area) => area.path)).size).toBe(areas.length);
  expect(new Set(areas.map((area) => area.label)).size).toBe(areas.length);
});

test("the dashboard is the start page", () => {
  expect(areas.find((area) => area.path === "/")?.label).toBe("Dashboard");
});
