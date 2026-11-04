import { fireEvent, render, screen, within } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { backlinksOf } from "../../lib/ipc/commands";
import { Backlinks } from "./Backlinks";

vi.mock("../../lib/ipc/commands", () => ({ backlinksOf: vi.fn() }));

const backlinksMock = vi.mocked(backlinksOf);

beforeEach(() => {
  backlinksMock.mockReset();
});

test("the notes linking here are listed with the line around each link", async () => {
  backlinksMock.mockResolvedValue([
    {
      path: "Ideas/Home.md",
      links: [
        { offset: 4, line: "See [[Plan]] here", from: 4, to: 12 },
        { offset: 30, line: "…and [[Plan#Next]]", from: 5, to: 18 },
      ],
    },
    {
      path: "Old.md",
      links: [{ offset: 0, line: "[[Plan]]", from: 0, to: 8 }],
    },
  ]);
  const onOpenAt = vi.fn();
  render(<Backlinks path="Plan.md" onOpenAt={onOpenAt} />);

  const toggle = await screen.findByRole("button", {
    name: "Linked from 2 notes",
  });
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(backlinksMock).toHaveBeenCalledWith("Plan.md");
  const band = screen.getByRole("region", { name: "Backlinks" });
  expect(within(band).getByText("Ideas")).toBeDefined();
  const line = within(band).getByRole("button", {
    name: "Open Home.md at: See [[Plan]] here",
  });
  expect(line.querySelector("span")?.textContent).toBe("[[Plan]]");

  fireEvent.click(line);
  expect(onOpenAt).toHaveBeenCalledWith("Ideas/Home.md", 4);
});

test("the band closes and stays closed for the next note", async () => {
  backlinksMock.mockResolvedValue([
    {
      path: "Home.md",
      links: [{ offset: 0, line: "[[Plan]]", from: 0, to: 8 }],
    },
  ]);
  const { unmount } = render(<Backlinks path="Plan.md" onOpenAt={vi.fn()} />);
  const toggle = await screen.findByRole("button", {
    name: "Linked from 1 note",
  });

  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: /^Open/ })).toBeNull();
  unmount();

  render(<Backlinks path="Other.md" onOpenAt={vi.fn()} />);
  const again = await screen.findByRole("button", {
    name: "Linked from 1 note",
  });
  expect(again.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(again);
});

test("no backlinks and failures are said quietly", async () => {
  backlinksMock.mockResolvedValueOnce([]);
  const { unmount } = render(<Backlinks path="Plan.md" onOpenAt={vi.fn()} />);
  expect(
    await screen.findByText("No other note links here yet."),
  ).toBeDefined();
  unmount();

  backlinksMock.mockRejectedValueOnce(new Error("x"));
  render(<Backlinks path="Plan.md" onOpenAt={vi.fn()} />);
  expect(
    await screen.findByText("Backlinks could not be loaded."),
  ).toBeDefined();
});
