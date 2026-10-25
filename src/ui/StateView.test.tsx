import { fireEvent, render, screen } from "@testing-library/react";
import { FileText } from "lucide-react";
import { expect, test, vi } from "vitest";
import { Button } from "./Button";
import { EmptyState, ErrorState, LoadingState } from "./StateView";

test("loading is announced as a status with its text", () => {
  render(<LoadingState label="Loading notes…" />);
  expect(screen.getByRole("status").textContent).toContain("Loading notes…");
});

test("an empty state shows title, text, and its action", () => {
  const onCreate = vi.fn();
  render(
    <EmptyState
      icon={FileText}
      title="No notes yet"
      description="Notes you create appear here."
      action={<Button onClick={onCreate}>Create note</Button>}
    />,
  );
  expect(screen.getByRole("heading", { name: "No notes yet" })).toBeDefined();
  expect(screen.getByText("Notes you create appear here.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Create note" }));
  expect(onCreate).toHaveBeenCalledOnce();
});

test("an error state is announced right away", () => {
  render(
    <ErrorState
      title="Could not open the project"
      description="The folder was moved or deleted."
    />,
  );
  const alert = screen.getByRole("alert");
  expect(alert.textContent).toContain("Could not open the project");
  expect(alert.textContent).toContain("The folder was moved or deleted.");
});
