import { WidgetType } from "@codemirror/view";
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
    case "notShown":
      return `This image type is not shown yet: ${source.written}`;
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
  img.addEventListener("load", () => {
    if (knownSizes.size >= MAX_KNOWN) {
      knownSizes.clear();
    }
    if (img.naturalWidth > 0) {
      knownSizes.set(address, {
        width: img.naturalWidth,
        height: img.naturalHeight,
      });
    }
  });
  img.addEventListener("error", () => {
    img.replaceWith(placeholder(`Image could not be shown: ${image.alt}`));
  });
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
  constructor(private readonly image: NoteImage) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return imageKey(other.image) === imageKey(this.image);
  }

  toDOM(): HTMLElement {
    return imageElement(this.image);
  }

  // A click places the cursor here, which brings the source back.
  override ignoreEvent(): boolean {
    return false;
  }
}
