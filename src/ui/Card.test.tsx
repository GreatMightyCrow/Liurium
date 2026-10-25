import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { Card } from "./Card";

test("shows its heading and content", () => {
  render(
    <Card title="Recent notes">
      <p>Nothing yet.</p>
    </Card>,
  );
  expect(screen.getByRole("heading", { name: "Recent notes" })).toBeDefined();
  expect(screen.getByText("Nothing yet.")).toBeDefined();
});
