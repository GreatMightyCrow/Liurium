import { fireEvent, render, screen } from "@testing-library/react";
import { Trash2 } from "lucide-react";
import { expect, test, vi } from "vitest";
import { Button } from "./Button";
import { IconButton } from "./IconButton";
import { TooltipProvider } from "./Tooltip";

test("a button does not submit forms unless asked to", () => {
  render(<Button>Save</Button>);
  expect(
    screen.getByRole("button", { name: "Save" }).getAttribute("type"),
  ).toBe("button");
});

test("a disabled button ignores clicks", () => {
  const onClick = vi.fn();
  render(
    <Button disabled onClick={onClick}>
      Save
    </Button>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onClick).not.toHaveBeenCalled();
});

test("an icon button is named by its label, the icon stays hidden", () => {
  const onClick = vi.fn();
  render(
    <TooltipProvider>
      <IconButton icon={Trash2} label="Delete note" onClick={onClick} />
    </TooltipProvider>,
  );
  const button = screen.getByRole("button", { name: "Delete note" });
  expect(button.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
  fireEvent.click(button);
  expect(onClick).toHaveBeenCalledOnce();
});
