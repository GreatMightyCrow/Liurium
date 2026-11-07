// What the page and the diagram frame say to each other (M3-011). Each side treats what
// it receives as untrusted: the frame runs Mermaid on a note's text.

/** Where the frame comes from: Rust's protocol, not the app's own address. */
export const FRAME_ADDRESS =
  "http://liurium-diagram.localhost/diagram-frame.html";

/** How diagrams look now: Mermaid's `base` theme takes the current tokens' values. */
export interface DiagramLook {
  dark: boolean;
  /** By Mermaid's names for them. */
  colors: Readonly<Record<string, string>>;
}

export interface DrawRequest {
  id: number;
  source: string;
  look: DiagramLook;
}

export type FrameMessage =
  | { kind: "ready" }
  | {
      kind: "drawn";
      id: number;
      svg: string;
      /** In pixels; 0 when the diagram does not say. */
      width: number;
      height: number;
      /** What a screen reader gets instead of the picture. */
      description: string;
    }
  | { kind: "failed"; id: number; reason: string };
