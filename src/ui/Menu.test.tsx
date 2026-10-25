import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { Button } from "./Button";
import { Menu, MenuItem, MenuSeparator } from "./Menu";

test("lists its items and runs the chosen one", async () => {
  const onDuplicate = vi.fn();
  render(
    <Menu trigger={<Button>Note actions</Button>}>
      <MenuItem onSelect={() => undefined}>Rename</MenuItem>
      <MenuItem onSelect={onDuplicate}>Duplicate</MenuItem>
      <MenuSeparator />
      <MenuItem onSelect={() => undefined} disabled>
        Delete
      </MenuItem>
    </Menu>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Note actions" }));
  const items = await screen.findAllByRole("menuitem");
  expect(items.map((item) => item.textContent)).toEqual([
    "Rename",
    "Duplicate",
    "Delete",
  ]);
  expect(items[2].getAttribute("aria-disabled")).toBe("true");
  fireEvent.click(items[1]);
  expect(onDuplicate).toHaveBeenCalledOnce();
  await waitFor(() => {
    expect(screen.queryByRole("menu")).toBeNull();
  });
});
