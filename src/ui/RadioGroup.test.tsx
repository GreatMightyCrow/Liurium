import { fireEvent, render, screen } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { RadioGroup } from "./RadioGroup";

const options = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

test("names the group and marks the chosen option", () => {
  render(
    <RadioGroup
      label="Mode"
      value="light"
      options={options}
      onChange={() => undefined}
    />,
  );

  const group = screen.getByRole("radiogroup", { name: "Mode" });
  expect(group).toBeDefined();
  expect(
    screen.getByRole("radio", { name: "Light" }).getAttribute("aria-checked"),
  ).toBe("true");
  expect(
    screen.getByRole("radio", { name: "Dark" }).getAttribute("aria-checked"),
  ).toBe("false");
});

test("choosing an option reports its value", () => {
  const onChange = vi.fn();
  render(
    <RadioGroup
      label="Mode"
      value="system"
      options={options}
      onChange={onChange}
    />,
  );

  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

  expect(onChange).toHaveBeenCalledWith("dark");
});

test("a mark is decoration; the label names the option", () => {
  render(
    <RadioGroup
      label="Theme"
      value="mint"
      options={[{ value: "mint", label: "Mint", mark: <span>dot</span> }]}
      onChange={() => undefined}
    />,
  );

  expect(screen.getByRole("radio", { name: "Mint" })).toBeDefined();
  expect(
    screen.getByText("dot").parentElement?.getAttribute("aria-hidden"),
  ).toBe("true");
});

test("a disabled group cannot be changed", () => {
  const onChange = vi.fn();
  render(
    <RadioGroup
      label="Mode"
      value="system"
      options={options}
      onChange={onChange}
      disabled
    />,
  );

  fireEvent.click(screen.getByRole("radio", { name: "Dark" }));

  expect(onChange).not.toHaveBeenCalled();
});
