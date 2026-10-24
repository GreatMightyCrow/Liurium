// Window frame styles (ADR-0013). Rust creates the window and passes its style
// as `?frame=<style>`; anything unexpected falls back to the native frame.
export type FrameStyle = "native" | "liurium" | "hidden";

export function frameStyleFrom(search: string): FrameStyle {
  const value = new URLSearchParams(search).get("frame");
  return value === "liurium" || value === "hidden" ? value : "native";
}
