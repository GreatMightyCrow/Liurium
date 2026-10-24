import { expect, test } from "vitest";
import { frameStyleFrom } from "./frameStyle";

test.each([
  ["?frame=liurium", "liurium"],
  ["?frame=hidden", "hidden"],
  ["?frame=native", "native"],
])("reads %s", (search, style) => {
  expect(frameStyleFrom(search)).toBe(style);
});

// Rust always passes a known value; anything else must not break the window.
test.each(["", "?frame=", "?frame=HIDDEN", "?frame=<script>", "?other=hidden"])(
  "falls back to native for %j",
  (search) => {
    expect(frameStyleFrom(search)).toBe("native");
  },
);
