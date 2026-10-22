import { expect, test } from "vitest";
import mainSource from "../main.tsx?raw";

// A cascade layer's precedence is fixed where it first appears in the bundle.
// index.css declares the order, so it must load before any component styles.
test("main.tsx imports the layer order before anything else", () => {
  const firstImport = /^import\s.*$/m.exec(mainSource)?.[0];
  expect(firstImport).toBe('import "./styles/index.css";');
});
