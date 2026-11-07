import { EditorState } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import type { ImageSource, NoteImage } from "../../lib/ipc/commands";
import { axeViolations } from "../../test/axe";
import { imageElement, imageKey, ImageWidget, imageNote } from "./liveImages";

const ADDRESS = "http://liurium-image.localhost/p/pic.png?v=1-2";

function image(
  source: ImageSource,
  size: { width?: number; height?: number } = {},
): NoteImage {
  return {
    from: 0,
    to: 5,
    alt: "A cat",
    width: size.width ?? null,
    height: size.height ?? null,
    source,
  };
}

const local = (size = {}) => image({ state: "local", address: ADDRESS }, size);

describe("placeholders say why", () => {
  test.each<[ImageSource, string]>([
    [
      { state: "remote", address: "https://example.com/x.png" },
      "Remote image not loaded: https://example.com/x.png",
    ],
    [{ state: "missing", written: "x.png" }, "Image not found: x.png"],
    [
      { state: "ambiguous", candidates: ["a/x.png", "b/x.png"] },
      "Several images fit: a/x.png, b/x.png",
    ],
    [
      { state: "ambiguous", candidates: ["a", "b", "c", "d", "e"] },
      "Several images fit: a, b, c, and 2 more",
    ],
    [
      { state: "refused" },
      "Image not shown: it is outside the project or in a hidden folder",
    ],
  ])("%j", (source, text) => {
    const element = imageElement(image(source));
    expect(element.tagName).toBe("SPAN");
    expect(element.textContent).toBe(text);
    expect(imageNote(image(source))).toBe(text);
  });

  test("a note's text stays text", () => {
    const element = imageElement(
      image({ state: "missing", written: "<img src=x onerror=alert(1)>.png" }),
    );
    expect(element.querySelector("img")).toBeNull();
    expect(element.children).toHaveLength(0);
  });

  test("a remote image makes no image element at all", () => {
    const element = imageElement(
      image({ state: "remote", address: "https://example.com/x.png" }),
    );
    expect(element).not.toBeInstanceOf(HTMLImageElement);
  });
});

describe("a local image", () => {
  test("loads from Rust's address with the note's alt text", () => {
    const element = imageElement(local()) as HTMLImageElement;
    expect(element.tagName).toBe("IMG");
    expect(element.src).toBe(ADDRESS);
    expect(element.alt).toBe("A cat");
    expect(element.draggable).toBe(false);
    expect(element.classList.contains("cm-image-auto")).toBe(true);
    expect(element.hasAttribute("width")).toBe(false);
  });

  test("takes the size the note asks for", () => {
    const wide = imageElement(local({ width: 200 })) as HTMLImageElement;
    expect(wide.getAttribute("width")).toBe("200");
    expect(wide.hasAttribute("height")).toBe(false);
    expect(wide.classList.contains("cm-image-auto")).toBe(true);

    const both = imageElement(
      local({ width: 200, height: 100 }),
    ) as HTMLImageElement;
    expect(both.getAttribute("height")).toBe("100");
    expect(both.classList.contains("cm-image-auto")).toBe(false);
  });

  test("a failure becomes a placeholder in its place", () => {
    const parent = document.createElement("div");
    const element = imageElement(local());
    parent.appendChild(element);
    element.dispatchEvent(new Event("error"));
    expect(parent.querySelector("img")).toBeNull();
    expect(parent.textContent).toBe("Image could not be shown: A cat");
  });

  test("a size seen once is kept for next time, so the text does not jump", () => {
    const address = "http://liurium-image.localhost/p/seen.png?v=1-2";
    const source: ImageSource = { state: "local", address };
    const first = imageElement(image(source)) as HTMLImageElement;
    Object.defineProperty(first, "naturalWidth", { value: 640 });
    Object.defineProperty(first, "naturalHeight", { value: 320 });
    first.dispatchEvent(new Event("load"));

    const again = imageElement(image(source)) as HTMLImageElement;
    expect(again.getAttribute("width")).toBe("640");
    expect(again.getAttribute("height")).toBe("320");

    const narrower = imageElement(
      image(source, { width: 100 }),
    ) as HTMLImageElement;
    expect(narrower.getAttribute("width")).toBe("100");
    expect(narrower.getAttribute("height")).toBe("50");
  });

  test.each([
    "http://liurium-image.localhost/p/draw.svg?v=1-2",
    "http://liurium-image.localhost/p/DRAW.SVG?v=1-2",
  ])("an SVG's natural size is not kept: %s", (address) => {
    const source: ImageSource = { state: "local", address };
    const first = imageElement(image(source)) as HTMLImageElement;
    Object.defineProperty(first, "naturalWidth", { value: 300 });
    Object.defineProperty(first, "naturalHeight", { value: 150 });
    first.dispatchEvent(new Event("load"));

    const again = imageElement(image(source)) as HTMLImageElement;
    expect(again.hasAttribute("width")).toBe(false);
    expect(again.hasAttribute("height")).toBe(false);
    expect(again.classList.contains("cm-image-auto")).toBe(true);
  });

  test("a name that only holds .svg is kept like any picture", () => {
    const address = "http://liurium-image.localhost/p/a.svg.png?v=1-2";
    const source: ImageSource = { state: "local", address };
    const first = imageElement(image(source)) as HTMLImageElement;
    Object.defineProperty(first, "naturalWidth", { value: 40 });
    Object.defineProperty(first, "naturalHeight", { value: 20 });
    first.dispatchEvent(new Event("load"));

    const again = imageElement(image(source)) as HTMLImageElement;
    expect(again.getAttribute("width")).toBe("40");
  });

  test("what loads with no size becomes a placeholder", () => {
    const parent = document.createElement("div");
    const element = imageElement(local());
    parent.appendChild(element);
    Object.defineProperty(element, "naturalWidth", { value: 0 });
    element.dispatchEvent(new Event("load"));
    expect(parent.querySelector("img")).toBeNull();
    expect(parent.textContent).toBe("Image could not be shown: A cat");
  });
});

describe("in a real editor", () => {
  /** A real editor showing the image, as jsdom's mutation observer is enough for this:
   *  the editor puts back what it thinks is its own (found by E2E, M3-019). */
  function editorWith(widget: ImageWidget) {
    const parent = document.createElement("div");
    document.body.append(parent);
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "a ![x](y.png) b",
        extensions: EditorView.decorations.of(
          Decoration.set(Decoration.replace({ widget }).range(2, 13)),
        ),
      }),
    });
    return {
      content: view.contentDOM,
      done: () => {
        view.destroy();
        parent.remove();
      },
    };
  }
  const settled = () =>
    new Promise((resolve) => {
      setTimeout(resolve, 50);
    });

  // jsdom has no layout, and the editor measures after each change.
  beforeAll(() => {
    Object.defineProperty(Range.prototype, "getClientRects", {
      configurable: true,
      value: () => [],
    });
  });
  afterAll(() => {
    Reflect.deleteProperty(Range.prototype, "getClientRects");
  });

  test.each<[string, (element: HTMLImageElement) => void]>([
    [
      "fails to load",
      (element) => {
        element.dispatchEvent(new Event("error"));
      },
    ],
    [
      "loads with no size",
      (element) => {
        Object.defineProperty(element, "naturalWidth", { value: 0 });
        element.dispatchEvent(new Event("load"));
      },
    ],
  ])("the placeholder stays when an image %s", async (_name, happen) => {
    const { content, done } = editorWith(new ImageWidget(local()));
    const shown = content.querySelector<HTMLImageElement>("img.cm-image");
    expect(shown).not.toBeNull();
    if (shown !== null) {
      happen(shown);
    }
    await settled();

    expect(content.querySelector("img.cm-image")).toBeNull();
    expect(content.querySelector(".cm-image-note")?.textContent).toBe(
      "Image could not be shown: A cat",
    );
    done();
  });

  test("an image that loads stays in the line's text", async () => {
    const { content, done } = editorWith(new ImageWidget(local()));
    await settled();
    expect(content.querySelector(".cm-line")?.textContent).toBe("a  b");
    expect(content.querySelector(".cm-line img.cm-image")).not.toBeNull();
    done();
  });
});

describe("widgets", () => {
  test("the place in the text does not count, so typing does not load it again", () => {
    const moved = { ...local(), from: 40, to: 45 };
    expect(new ImageWidget(local()).eq(new ImageWidget(moved))).toBe(true);
    expect(imageKey(local())).toBe(imageKey(moved));
  });

  test("another address, text, or size does", () => {
    const widget = new ImageWidget(local());
    const changed = image({
      state: "local",
      address: "http://liurium-image.localhost/p/pic.png?v=2-2",
    });
    expect(widget.eq(new ImageWidget(changed))).toBe(false);
    expect(widget.eq(new ImageWidget({ ...local(), alt: "Dog" }))).toBe(false);
    expect(widget.eq(new ImageWidget(local({ width: 10 })))).toBe(false);
  });
});

test("images and placeholders pass axe", async () => {
  const main = document.createElement("main");
  main.append(
    imageElement(local()),
    imageElement(image({ state: "missing", written: "x.png" })),
  );
  document.body.replaceChildren(main);
  expect(await axeViolations()).toEqual([]);
  document.body.replaceChildren();
});
