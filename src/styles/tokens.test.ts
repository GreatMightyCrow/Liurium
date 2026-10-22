import { describe, expect, test } from "vitest";
import tokensCss from "./tokens.css?raw";

const colors = new Map(
  Array.from(
    tokensCss.matchAll(/(--color-[a-z-]+):\s*(#[0-9a-f]{6});/gi),
    (match) => [match[1], match[2]],
  ),
);

function color(name: string): string {
  const value = colors.get(name);
  if (value === undefined) {
    throw new Error(
      `${name} is not defined as a 6-digit hex color in tokens.css`,
    );
  }
  return value;
}

// WCAG 2.x relative luminance and contrast ratio.
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((start) => {
    const channel = parseInt(hex.slice(start, start + 2), 16) / 255;
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [
    luminance(color(foreground)),
    luminance(color(background)),
  ].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

function pairs(
  foregrounds: string[],
  backgrounds: string[],
): [string, string][] {
  return foregrounds.flatMap((fg) =>
    backgrounds.map((bg): [string, string] => [fg, bg]),
  );
}

const surfaces = [
  "--color-canvas",
  "--color-surface",
  "--color-surface-elevated",
];

describe("token contrast (WCAG AA)", () => {
  test.each(
    pairs(
      [
        "--color-text",
        "--color-text-secondary",
        "--color-accent",
        "--color-accent-hover",
        "--color-success",
        "--color-warning",
        "--color-danger",
      ],
      [...surfaces, "--color-accent-muted"],
    ),
  )("text %s on %s reaches 4.5:1", (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(
    pairs(["--color-on-accent"], ["--color-accent", "--color-accent-hover"]),
  )("text %s on %s reaches 4.5:1", (fg, bg) => {
    expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
  });

  test.each(pairs(["--color-border-control", "--color-accent"], surfaces))(
    "control indicator %s on %s reaches 3:1",
    (fg, bg) => {
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(3);
    },
  );
});
