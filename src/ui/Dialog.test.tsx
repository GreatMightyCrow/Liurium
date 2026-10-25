import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test } from "vitest";
import { Button } from "./Button";
import { Dialog, DialogClose } from "./Dialog";

function renderDialog() {
  render(
    <Dialog
      trigger={<Button>Rename</Button>}
      title="Rename note"
      description="The file on disk is renamed too."
      actions={<DialogClose>Cancel</DialogClose>}
    >
      <p>Body</p>
    </Dialog>,
  );
}

test("opens from its trigger as a named dialog", async () => {
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  const dialog = await screen.findByRole("dialog", { name: "Rename note" });
  expect(dialog.textContent).toContain("The file on disk is renamed too.");
});

test("the close action closes it", async () => {
  renderDialog();
  fireEvent.click(screen.getByRole("button", { name: "Rename" }));
  fireEvent.click(await screen.findByRole("button", { name: "Cancel" }));
  await waitFor(() => {
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
