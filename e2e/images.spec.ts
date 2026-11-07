import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, join } from "node:path";
import { deflateSync } from "node:zlib";
import type { Page } from "@playwright/test";
import { expect, test } from "./app";

/** A real PNG of one color, made here so the tests need no binary file. */
function png(width: number, height: number, rgb: [number, number, number]) {
  const crc = (bytes: Buffer) => {
    let value = ~0;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit += 1) {
        value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
      }
    }
    return ~value >>> 0;
  };
  const chunk = (name: string, data: Buffer) => {
    const typed = Buffer.concat([Buffer.from(name, "ascii"), data]);
    const out = Buffer.alloc(typed.length + 8);
    out.writeUInt32BE(data.length, 0);
    typed.copy(out, 4);
    out.writeUInt32BE(crc(typed), typed.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.concat([
    Buffer.from([0]),
    ...Array.from({ length: width }, () => Buffer.from(rgb)),
  ]);
  return Buffer.concat([
    Buffer.from("\x89PNG\r\n\x1a\n", "latin1"),
    chunk("IHDR", header),
    chunk(
      "IDAT",
      deflateSync(Buffer.concat(Array.from({ length: height }, () => row))),
    ),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const TEAL: [number, number, number] = [20, 140, 130];
const CORAL: [number, number, number] = [220, 90, 70];

const SVG_NAMESPACE = 'xmlns="http://www.w3.org/2000/svg"';
const SIZED_SVG = `<svg ${SVG_NAMESPACE} width="200" height="100"><rect width="200" height="100" fill="#148c82"/></svg>`;

function write(folder: string, name: string, bytes: Buffer | string) {
  const path = join(folder, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, bytes);
}

async function openNote(page: Page, name = "Plan.md", folder?: string) {
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Projects" })
    .click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
  await page
    .getByRole("navigation", { name: "Primary" })
    .getByRole("link", { name: "Notes" })
    .click();
  if (folder !== undefined) {
    await page
      .getByRole("navigation", { name: "Notes in this project" })
      .getByRole("button", { name: folder, exact: true })
      .click();
  }
  await page
    .getByRole("navigation", { name: "Notes in this project" })
    .getByRole("link", { name })
    .click();
  await expect(page.locator(".cm-content")).toBeVisible();
}

/** Waits for a real picture, not only an element. */
async function loaded(page: Page, index = 0) {
  const image = page.locator(".cm-content img.cm-image").nth(index);
  await expect(image).toBeVisible();
  await expect
    .poll(() =>
      image.evaluate((element) => (element as HTMLImageElement).naturalWidth),
    )
    .toBeGreaterThan(0);
  return image;
}

test("an image shows at its size, its source comes back at the cursor, the file stays", async ({
  app,
}) => {
  const folder = app.folder("Images-");
  const before = "before\r\n\r\n![A cat](pics/cat.png)\r\n\r\nafter\r\n";
  write(folder, "Plan.md", before);
  write(folder, "pics/cat.png", png(60, 30, TEAL));
  const page = await app.launch({ pick: folder });
  const violations: string[] = [];
  page.on("console", (message) => {
    if (message.text().includes("Content Security Policy")) {
      violations.push(message.text());
    }
  });
  await openNote(page);

  const image = await loaded(page);
  expect(await image.getAttribute("alt")).toBe("A cat");
  expect(await image.evaluate((element) => element.clientWidth)).toBe(60);
  await expect(page.locator(".cm-content")).not.toContainText("pics/cat.png");

  // The cursor on its line shows the source, away from it the image again.
  await page.locator(".cm-content").getByText("before").click();
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await expect(page.locator(".cm-content")).toContainText(
    "![A cat](pics/cat.png)",
  );
  await expect(page.locator(".cm-content img.cm-image")).toHaveCount(0);
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("ArrowDown");
  await loaded(page);

  // A press on the image shows its source too, once the mouse is up.
  await page.locator(".cm-content img.cm-image").click();
  await expect(page.locator(".cm-content")).toContainText("pics/cat.png");

  // Typing elsewhere keeps the same element, so nothing loads again.
  await page.locator(".cm-content").getByText("after").click();
  const shown = await loaded(page);
  await shown.evaluate((element) => {
    element.dataset.mark = "kept";
  });
  await page.keyboard.press("End");
  await page.keyboard.type("!");
  await expect(page.locator(".cm-content")).toContainText("after!");
  await expect(
    page.locator('.cm-content img.cm-image[data-mark="kept"]'),
  ).toHaveCount(1);
  await page.keyboard.press("Backspace");
  await page.keyboard.press("Control+s");
  await expect
    .poll(() => readFileSync(join(folder, "Plan.md"), "utf8"))
    .toBe(before);

  // The source view shows only text.
  await page.getByRole("button", { name: "Show source" }).click();
  await expect(page.locator(".cm-content img.cm-image")).toHaveCount(0);
  await expect(page.locator(".cm-content")).toContainText("pics/cat.png");

  expect(violations).toEqual([]);
});

test("images are found by path and by name, and never guessed", async ({
  app,
}) => {
  const folder = app.folder("Images-");
  write(
    folder,
    "Ideas/Plan.md",
    [
      "![up](../shared/up.png)",
      "",
      "![[deep.png]]",
      "",
      "![[same.png]]",
      "",
      "![[nope.png]]",
      "",
      "![out](../../outside.png)",
      "",
      "![hidden](.liurium/x.png)",
      "",
      "- in a list ![[deep.png|Deep]]",
      "",
      "> [!note] A callout",
      "> ![[deep.png]]",
      "",
      "![a](data:image/png;base64,AAAA)",
      "",
    ].join("\n"),
  );
  write(folder, "shared/up.png", png(10, 10, TEAL));
  write(folder, "very/far/deep.png", png(12, 12, CORAL));
  write(folder, "One/same.png", png(8, 8, TEAL));
  write(folder, "Two/same.png", png(8, 8, CORAL));
  const page = await app.launch({ pick: folder });
  await openNote(page, "Plan.md", "Ideas");

  await loaded(page);
  await expect(page.locator(".cm-content img.cm-image")).toHaveCount(4);
  await expect(
    page.locator(".cm-content img.cm-image").first(),
  ).toHaveAttribute("alt", "up");
  await expect(
    page.locator('.cm-content img.cm-image[alt="Deep"]'),
  ).toBeVisible();

  const notes = page.locator(".cm-image-note");
  await expect(notes).toHaveText([
    "Several images fit: One/same.png, Two/same.png",
    "Image not found: nope.png",
    "Image not shown: it is outside the project or in a hidden folder",
    "Image not shown: it is outside the project or in a hidden folder",
  ]);
  // Not an image Rust resolved: stays what it is.
  await expect(page.locator(".cm-content")).toContainText(
    "data:image/png;base64,AAAA",
  );
});

test("a remote image is named and never requested", async ({ app }) => {
  let requests = 0;
  const server = createServer((_request, response) => {
    requests += 1;
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const address = `http://127.0.0.1:${String(port)}/pixel.png`;
  try {
    const folder = app.folder("Images-");
    write(folder, "Plan.md", `![spy](${address})\n\nend\n`);
    const page = await app.launch({ pick: folder });
    await openNote(page);

    await expect(page.locator(".cm-image-note")).toHaveText(
      `Remote image not loaded: ${address}`,
    );
    await expect(page.locator(".cm-content img.cm-image")).toHaveCount(0);
    // CSP is the second wall: even made by hand the request does not go out.
    await page.evaluate(async (url) => {
      await new Promise<void>((resolve) => {
        const probe = new Image();
        probe.onload = probe.onerror = () => {
          resolve();
        };
        probe.src = url;
      });
    }, address);
    expect(requests).toBe(0);
  } finally {
    server.close();
  }
});

test("the protocol gives images of the open project and nothing else", async ({
  app,
}) => {
  const folder = app.folder("Images-");
  write(folder, "Plan.md", "![a](pic.png)\n\nend\n");
  write(folder, "pic.png", png(10, 10, TEAL));
  write(folder, "Secret.md", "# Secret\n");
  write(folder, "renamed.png", "# Secret\n");
  write(folder, "node_modules/x.png", png(10, 10, TEAL));
  write(folder, "note.svg", "# Secret\n");
  write(folder, "base.svg", "SQLite format 3\0");
  write(folder, "picture.svg", png(10, 10, TEAL));
  write(folder, "drawing.png", SIZED_SVG);
  write(folder, "node_modules/x.svg", SIZED_SVG);
  const page = await app.launch({ pick: folder });
  await openNote(page);

  const image = await loaded(page);
  const address = (await image.getAttribute("src")) ?? "";
  const project = /^http:\/\/liurium-image\.localhost\/[^/]+/.exec(
    address,
  )?.[0];
  expect(project).toBeDefined();

  const loads = (url: string) =>
    page.evaluate(
      (each) =>
        new Promise<boolean>((resolve) => {
          const probe = new Image();
          probe.onload = () => {
            resolve(true);
          };
          probe.onerror = () => {
            resolve(false);
          };
          probe.src = each;
        }),
      url,
    );
  expect(await loads(address)).toBe(true);
  for (const path of [
    "/.liurium/project.db",
    "/Secret.md",
    "/renamed.png",
    "/node_modules/x.png",
    "/note.svg",
    "/base.svg",
    "/picture.svg",
    "/drawing.png",
    "/node_modules/x.svg",
    "/../pic.png",
    "/..%2F..%2Fpic.png",
    "/missing.png",
  ]) {
    expect(await loads(`${String(project)}${path}`), path).toBe(false);
  }
  // Another project's address.
  expect(
    await loads("http://liurium-image.localhost/not-this-project/pic.png"),
  ).toBe(false);

  // The page cannot read one as data at all: only the CSP's image source names it.
  const read = await page.evaluate(async (url) => {
    try {
      await fetch(url);
      return "read";
    } catch {
      return "blocked";
    }
  }, address);
  expect(read).toBe("blocked");
});

test("a size in the note is used, never above the text's width", async ({
  app,
}) => {
  const folder = app.folder("Images-");
  write(
    folder,
    "Plan.md",
    "![[pic.png|120]]\n\n![[pic.png|120x30]]\n\n![Cat|90](pic.png)\n\n![[pic.png|9000]]\n\nend\n",
  );
  write(folder, "pic.png", png(60, 60, TEAL));
  const page = await app.launch({ pick: folder });
  await openNote(page);

  await loaded(page);
  const size = (index: number) =>
    page
      .locator(".cm-content img.cm-image")
      .nth(index)
      .evaluate((element) => [element.clientWidth, element.clientHeight]);
  await expect.poll(() => size(0)).toEqual([120, 120]);
  await expect.poll(() => size(1)).toEqual([120, 30]);
  await expect(page.locator(".cm-content img.cm-image").nth(2)).toHaveAttribute(
    "alt",
    "Cat",
  );
  await expect.poll(() => size(2)).toEqual([90, 90]);
  const line = await page
    .locator(".cm-content .cm-line")
    .first()
    .evaluate((element) => element.clientWidth);
  const [widest] = await size(3);
  expect(widest).toBeGreaterThan(120);
  expect(widest).toBeLessThanOrEqual(line);
});

test("an image in a table shows in its cell and does not load again while typing", async ({
  app,
}) => {
  const folder = app.folder("Images-");
  const before =
    "first\n\n| Name | Picture | Link |\n|---|---|---|\n| Ana | ![[pic.png\\|40]] | [[Other]] |\n\nend\n";
  write(folder, "Plan.md", before);
  write(folder, "Other.md", "# Other\n");
  write(folder, "pic.png", png(60, 60, TEAL));
  const page = await app.launch({ pick: folder });
  await openNote(page);

  const cell = (row: number, column: number) =>
    page.locator(`[data-cell="${String(row)}:${String(column)}"]`);
  const image = await loaded(page);
  await expect(cell(1, 1).locator("img.cm-image")).toBeVisible();
  expect(await image.evaluate((element) => element.clientWidth)).toBe(40);

  await image.evaluate((element) => {
    element.dataset.mark = "kept";
  });
  await cell(1, 0).click();
  await page.locator(".cm-cell-input").pressSequentially("xy");
  await expect
    .poll(() => readFileSync(join(folder, "Plan.md"), "utf8"))
    .toBe(before.replace("| Ana |", "| Anaxy |"));
  await expect(
    cell(1, 1).locator('img.cm-image[data-mark="kept"]'),
  ).toHaveCount(1);

  // In its cell the source is text to edit, and leaving shows the image again.
  await page.keyboard.press("Tab");
  await expect(page.locator(".cm-cell-input")).toHaveValue("![[pic.png|40]]");
  await page.keyboard.press("Tab");
  await expect(cell(1, 1).locator("img.cm-image")).toBeVisible();

  // A link in a cell that was left still follows.
  await expect(page.locator(".cm-cell-input")).toHaveValue("[[Other]]");
  await page.keyboard.press("Escape");
  await cell(1, 2).locator(".cm-link-note").click();
  await expect(page.getByRole("heading", { name: "Other.md" })).toBeVisible();
});

test("an image changed outside shows the new picture without touching the note", async ({
  app,
}) => {
  const folder = app.folder("Images-");
  const before = "![a](pic.png)\n\nend\n";
  write(folder, "Plan.md", before);
  write(folder, "pic.png", png(30, 30, TEAL));
  const page = await app.launch({ pick: folder });
  await openNote(page);

  const natural = () =>
    page
      .locator(".cm-content img.cm-image")
      .evaluate((element) => (element as HTMLImageElement).naturalWidth);
  await loaded(page);
  await expect.poll(natural).toBe(30);

  write(folder, "pic.png", png(50, 50, CORAL));
  await expect.poll(natural, { timeout: 15_000 }).toBe(50);
  expect(readFileSync(join(folder, "Plan.md"), "utf8")).toBe(before);
});

test("an image added outside appears where a placeholder stood", async ({
  app,
}) => {
  const folder = app.folder("Images-");
  write(folder, "Plan.md", "![[late.png]]\n\nend\n");
  const page = await app.launch({ pick: folder });
  await openNote(page);

  await expect(page.locator(".cm-image-note")).toHaveText(
    "Image not found: late.png",
  );
  write(folder, "sub/late.png", png(20, 20, TEAL));
  await expect(page.locator(".cm-content img.cm-image")).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.locator(".cm-image-note")).toHaveCount(0);
});

test("an SVG shows at its size, also when it shows again, in text and a table cell", async ({
  app,
}) => {
  const folder = app.folder("Images-");
  const before = [
    "first",
    "",
    "![[sized.svg]]",
    "",
    "![Wide](pics/wide.svg)",
    "",
    "![[sized.svg|50]]",
    "",
    "| Picture |",
    "|---|",
    "| ![[sized.svg\\|40]] |",
    "",
    "end",
    "",
  ].join("\n");
  write(folder, "Plan.md", before);
  write(folder, "sized.svg", SIZED_SVG);
  write(
    folder,
    "pics/wide.svg",
    `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<!-- only a viewBox -->\n<svg ${SVG_NAMESPACE} viewBox="0 0 400 200"><rect width="400" height="200" fill="#148c82"/></svg>`,
  );
  const page = await app.launch({ pick: folder });
  await openNote(page);

  await loaded(page);
  const images = page.locator(".cm-content img.cm-image");
  await expect(images).toHaveCount(4);
  const size = (index: number) =>
    images
      .nth(index)
      .evaluate((element) => [element.clientWidth, element.clientHeight]);
  await expect.poll(() => size(0)).toEqual([200, 100]);
  await expect.poll(() => size(2)).toEqual([50, 25]);
  await expect.poll(() => size(3)).toEqual([40, 20]);
  await expect(page.locator('[data-cell="1:0"] img.cm-image')).toBeVisible();

  // A `viewBox` alone fills the text's width, and must not shrink when it shows again.
  const line = await page
    .locator(".cm-content .cm-line")
    .first()
    .evaluate((element) => element.clientWidth);
  const wide = page.locator('.cm-content img.cm-image[alt="Wide"]');
  const wideSize = () =>
    wide.evaluate((element) => [element.clientWidth, element.clientHeight]);
  await expect.poll(async () => (await wideSize())[0]).toBeGreaterThan(300);
  const [width, height] = await wideSize();
  expect(width).toBeLessThanOrEqual(line);
  expect(height).toBe(Math.round(width / 2));

  await wide.click();
  await expect(page.locator(".cm-content")).toContainText(
    "![Wide](pics/wide.svg)",
  );
  await expect(wide).toHaveCount(0);
  await page.locator(".cm-content").getByText("first").click();
  await expect(wide).toBeVisible();
  await expect.poll(wideSize).toEqual([width, height]);

  // The file stays what it was.
  expect(readFileSync(join(folder, "Plan.md"), "utf8")).toBe(before);
});

test("an SVG that fails shows why, and one changed outside shows anew", async ({
  app,
}) => {
  const folder = app.folder("Images-");
  const before =
    "![[broken.svg]]\n\n![[empty.svg]]\n\n![[nothing.svg]]\n\n![[renamed.png]]\n\n![[late.svg]]\n\nend\n";
  write(folder, "Plan.md", before);
  write(folder, "renamed.png", "# Not an image\n");
  write(folder, "broken.svg", `<svg ${SVG_NAMESPACE}><rect>`);
  write(folder, "empty.svg", "# Not an image\n");
  write(folder, "nothing.svg", `<svg ${SVG_NAMESPACE} width="0" height="0"/>`);
  write(folder, "late.svg", SIZED_SVG);
  const page = await app.launch({ pick: folder });
  await openNote(page);

  await expect(page.locator(".cm-image-note")).toHaveText([
    "Image could not be shown: broken.svg",
    "Image could not be shown: empty.svg",
    "Image could not be shown: nothing.svg",
    "Image could not be shown: renamed.png",
  ]);
  const late = await loaded(page);
  await expect.poll(() => late.evaluate((e) => e.clientWidth)).toBe(200);

  write(
    folder,
    "late.svg",
    `<svg ${SVG_NAMESPACE} width="90" height="90"><rect width="90" height="90"/></svg>`,
  );
  await expect
    .poll(
      () =>
        page
          .locator(".cm-content img.cm-image")
          .evaluate((element) => element.clientWidth),
      { timeout: 15_000 },
    )
    .toBe(90);
  expect(readFileSync(join(folder, "Plan.md"), "utf8")).toBe(before);
});

test("a hostile SVG runs nothing and asks nothing from outside", async ({
  app,
}) => {
  const requests: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request.url ?? "");
    response.setHeader("Access-Control-Allow-Origin", "*");
    response.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address() as AddressInfo;
  const spy = `http://127.0.0.1:${String(port)}`;
  try {
    // The counter counts: what follows would be empty anyway if it did not.
    await fetch(`${spy}/control`);
    expect(requests).toEqual(["/control"]);
    requests.length = 0;

    const SECRET = "secret-of-this-svg";
    const box = `${SVG_NAMESPACE} xmlns:xlink="http://www.w3.org/1999/xlink" width="50" height="50"`;
    const hostile = {
      script: `<svg ${box}><rect width="50" height="50"/><script>console.log("${SECRET}");document.title="${SECRET}";top.document.title="${SECRET}";fetch("${spy}/script");new Image().src="${spy}/script-image";</script></svg>`,
      onload: `<svg ${box} onload="console.log('${SECRET}');fetch('${spy}/onload')"><rect width="50" height="50"/></svg>`,
      image: `<svg ${box}><image href="${spy}/image.png" width="9" height="9"/><image xlink:href="${spy}/xlink.png" width="9" height="9"/></svg>`,
      css: `<svg ${box}><style>@import url(${spy}/import.css);@font-face{font-family:x;src:url(${spy}/font.woff2)}text{font-family:x}rect{fill:url(${spy}/fill.svg#a)}</style><text y="20">x</text><rect width="9" height="9"/></svg>`,
      use: `<svg ${box}><use href="${spy}/use.svg#a"/></svg>`,
      foreign: `<svg ${box}><foreignObject width="50" height="50"><div xmlns="http://www.w3.org/1999/xhtml"><img src="${spy}/foreign.png"/><iframe src="${spy}/frame"></iframe><link rel="stylesheet" href="${spy}/foreign.css"/><meta http-equiv="refresh" content="0;url=${spy}/refresh"/></div></foreignObject></svg>`,
      sheet: `<?xml version="1.0"?><?xml-stylesheet href="${spy}/sheet.css" type="text/css"?><svg ${box}/>`,
      entity: `<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "${spy}/entity">]><svg ${box}><text>&x;</text></svg>`,
      doctype: `<?xml version="1.0"?><!DOCTYPE svg SYSTEM "${spy}/doctype.dtd"><svg ${box}/>`,
      animate: `<svg ${box}><image width="9" height="9"><animate attributeName="href" to="${spy}/animate.png" dur="1ms" fill="freeze"/></image></svg>`,
      filter: `<svg ${box}><filter id="f"><feImage href="${spy}/filter.png"/></filter><rect width="9" height="9" filter="url(#f)"/></svg>`,
    };
    const folder = app.folder("Images-");
    const names = Object.keys(hostile);
    for (const [name, text] of Object.entries(hostile)) {
      write(folder, `${name}.svg`, text);
    }
    write(
      folder,
      "Plan.md",
      `${names.map((name) => `![[${name}.svg]]`).join("\n\n")}\n\nend\n`,
    );
    const page = await app.launch({ pick: folder });
    const said: string[] = [];
    page.on("console", (message) => said.push(message.text()));
    const title = await page.title();
    await openNote(page);

    // Each one drew: this is not passing because nothing was shown.
    const images = page.locator(".cm-content img.cm-image");
    await expect(images).toHaveCount(names.length);
    await expect
      .poll(() =>
        images.evaluateAll((all) =>
          all.every((each) => (each as HTMLImageElement).naturalWidth === 50),
        ),
      )
      .toBe(true);
    await expect(page.locator(".cm-image-note")).toHaveCount(0);
    // Give anything that would have started the time to arrive.
    await page.waitForTimeout(1000);

    expect(requests).toEqual([]);
    expect(said.filter((text) => text.includes(SECRET))).toEqual([]);
    expect(await page.title()).toBe(title);
    // It stayed in the page: nothing navigated it away.
    await expect(page.locator(".cm-content")).toContainText("end");
  } finally {
    server.close();
  }
});

test("a read-only note shows images too", async ({ app }) => {
  const folder = app.folder("Images-");
  // Mixed line endings open read-only.
  write(folder, "Plan.md", "a\r\nb\n\n![a](pic.png)\n");
  write(folder, "pic.png", png(20, 20, TEAL));
  const page = await app.launch({ pick: folder });
  await openNote(page);

  await loaded(page);
});
