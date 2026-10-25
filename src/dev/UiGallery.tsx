import { Copy, Pencil, Pin, Trash2 } from "lucide-react";
import { Button } from "../ui/Button";
import { Card } from "../ui/Card";
import { Dialog, DialogClose } from "../ui/Dialog";
import { IconButton } from "../ui/IconButton";
import { Menu, MenuItem, MenuSeparator } from "../ui/Menu";
import { PageHeader } from "../ui/PageHeader";
import { TextField } from "../ui/TextField";
import styles from "./UiGallery.module.css";

const nothing = () => undefined;

// Every primitive in its states, for design review and release-build checks.
// Only routed in dev or with VITE_UI_GALLERY=1 (see AppRoutes).
export default function UiGallery() {
  return (
    <>
      <PageHeader title="UI gallery" />
      <div className={styles.gallery}>
        <Card title="Buttons">
          <div className={styles.row} data-testid="gallery-buttons">
            <Button variant="primary">Create project</Button>
            <Button>Open folder</Button>
            <Button variant="ghost">Cancel</Button>
            <Button variant="danger">Delete</Button>
            <Button disabled>Disabled</Button>
          </div>
          <div className={styles.row}>
            <Button variant="primary" size="sm">
              Save
            </Button>
            <Button size="sm">Rename</Button>
            <Button variant="ghost" size="sm">
              More
            </Button>
          </div>
        </Card>

        <Card title="Icon buttons with tooltips">
          <div className={styles.row}>
            <IconButton
              icon={Pencil}
              label="Rename note"
              data-testid="gallery-tooltip-trigger"
            />
            <IconButton icon={Copy} label="Duplicate note" />
            <IconButton icon={Pin} label="Pin note" size="sm" />
            <IconButton icon={Trash2} label="Delete note" variant="danger" />
          </div>
        </Card>

        <Card title="Text fields">
          <div className={styles.fields}>
            <TextField
              label="Project name"
              placeholder="Liurium"
              description="Shown in the sidebar and the window title."
            />
            <TextField
              label="Folder"
              defaultValue={"C:\\Projects\\Missing"}
              error="This folder does not exist."
            />
            <TextField label="Created" defaultValue="2026-10-25" disabled />
          </div>
        </Card>

        <Card title="Dialog and menu">
          <div className={styles.row}>
            <Dialog
              trigger={
                <Button data-testid="gallery-dialog-trigger">
                  Rename note…
                </Button>
              }
              title="Rename note"
              description="The Markdown file on disk is renamed too."
              actions={
                <>
                  <DialogClose variant="ghost">Cancel</DialogClose>
                  <DialogClose variant="primary">Rename</DialogClose>
                </>
              }
            >
              <TextField label="New name" defaultValue="Meeting notes" />
            </Dialog>
            <Menu
              trigger={
                <Button data-testid="gallery-menu-trigger">Note actions</Button>
              }
            >
              <MenuItem onSelect={nothing}>Rename</MenuItem>
              <MenuItem onSelect={nothing}>Duplicate</MenuItem>
              <MenuItem onSelect={nothing}>Move to…</MenuItem>
              <MenuSeparator />
              <MenuItem onSelect={nothing} disabled>
                Delete
              </MenuItem>
            </Menu>
          </div>
        </Card>
      </div>
    </>
  );
}
