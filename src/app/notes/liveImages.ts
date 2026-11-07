import { type EditorView, WidgetType } from "@codemirror/view";
import type { NoteImage } from "../../lib/ipc/commands";

// Images in live preview (M3-013, ADR-0020): only what Rust resolved becomes an image
// element, and only from the address Rust gave. Everything else is a placeholder from
// DOM text that says why. The source stays what is saved; nothing here writes.

/** Sizes of images already seen, so a shown-again image does not make the text jump. */
const knownSizes = new Map<string, { width: number; height: number }>();
const MAX_KNOWN = 500;

const MAX_CANDIDATES_SHOWN = 3;

/** What a placeholder says; `null` for an image that loads. */
export function imageNote(image: NoteImage): string | null {
  const { source } = image;
  switch (source.state) {
    case "local":
      return null;
    case "remote":
      return `Remote image not loaded: ${source.address}`;
    case "missing":
      return `Image not found: ${source.written}`;
    case "ambiguous": {
      const shown = source.candidates.slice(0, MAX_CANDIDATES_SHOWN).join(", ");
      const more = source.candidates.length - MAX_CANDIDATES_SHOWN;
      return `Several images fit: ${shown}${more > 0 ? `, and ${String(more)} more` : ""}`;
    }
    default:
      return "Image not shown: it is outside the project or in a hidden folder";
  }
}

function placeholder(text: string): HTMLElement {
  const note = document.createElement("span");
  note.className = "cm-image-note";
  note.textContent = text;
  return note;
}

/** An SVG with only a `viewBox` reports 300 × 150 and shows at the text's width, so its
 *  natural size says nothing about how big it shows (M3-019). */
const isSvgAddress = (address: string) => /\.svg(?:\?|$)/i.test(address);

/** The image, or the placeholder that takes its place. */
export function imageElement(image: NoteImage): HTMLElement {
  const note = imageNote(image);
  if (image.source.state !== "local" || note !== null) {
    return placeholder(note ?? "");
  }
  const { address } = image.source;
  const img = document.createElement("img");
  img.className = "cm-image";
  img.alt = image.alt;
  img.draggable = false;
  const known = knownSizes.get(address);
  if (image.width !== null) {
    img.width = image.width;
    if (image.height !== null) {
      img.height = image.height;
    } else {
      img.classList.add("cm-image-auto");
      if (known !== undefined) {
        img.height = Math.round((image.width * known.height) / known.width);
      }
    }
  } else {
    img.classList.add("cm-image-auto");
    if (known !== undefined) {
      img.width = known.width;
      img.height = known.height;
    }
  }
  const fail = () => {
    img.replaceWith(placeholder(`Image could not be shown: ${image.alt}`));
  };
  img.addEventListener("load", () => {
    // `<svg width="0">` loads, and would leave nothing to see or click.
    if (img.naturalWidth === 0) {
      fail();
      return;
    }
    if (isSvgAddress(address)) {
      return;
    }
    if (knownSizes.size >= MAX_KNOWN) {
      knownSizes.clear();
    }
    knownSizes.set(address, {
      width: img.naturalWidth,
      height: img.naturalHeight,
    });
  });
  img.addEventListener("error", fail);
  // Last, so the listeners above cannot miss it.
  img.src = address;
  return img;
}

/** What makes two images look the same; their place in the text does not count, so
 *  typing before an image does not load it again. */
export function imageKey(image: NoteImage): string {
  return JSON.stringify([image.alt, image.width, image.height, image.source]);
}

export class ImageWidget extends WidgetType {
  constructor(
    private readonly image: NoteImage,
    /** How many images had settled; when it changes, the editor measures again. */
    private readonly settled = 0,
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return (
      imageKey(other.image) === imageKey(this.image) &&
      other.settled === this.settled
    );
  }

  /** The same image after another one settled: its element stays, so it does not load
   *  again, and the editor draws its line again and reads its height (M3-020). */
  override updateDOM(
    _dom: HTMLElement,
    _view: EditorView,
    from: this,
  ): boolean {
    return imageKey(from.image) === imageKey(this.image);
  }

  // A box that stays: the editor ignores changes inside a widget, but if its root were
  // replaced, it would put the failed image back over the placeholder.
  toDOM(): HTMLElement {
    const box = document.createElement("span");
    box.append(imageElement(this.image));
    return box;
  }

  // A click places the cursor here, which brings the source back.
  override ignoreEvent(): boolean {
    return false;
  }
}
