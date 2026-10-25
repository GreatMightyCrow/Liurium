import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { TextField } from "./TextField";

test("the label names the input and the description describes it", () => {
  render(
    <TextField label="Project name" description="Shown in the sidebar." />,
  );
  const input = screen.getByLabelText("Project name");
  const describedBy = input.getAttribute("aria-describedby") ?? "";
  expect(
    describedBy
      .split(" ")
      .map((id) => document.getElementById(id)?.textContent)
      .join(" "),
  ).toContain("Shown in the sidebar.");
});

test("an error marks the input invalid and is shown", () => {
  render(<TextField label="Project name" error="A name is required." />);
  const input = screen.getByLabelText("Project name");
  expect(input.getAttribute("aria-invalid")).toBe("true");
  expect(screen.getByText("A name is required.")).toBeDefined();
});
