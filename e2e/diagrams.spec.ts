import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { Frame, Page } from "@playwright/test";
import { expect, test } from "./app";

const FRAME_ADDRESS = "http://liurium-diagram.localhost/diagram-frame.html";

function write(folder: string, name: string, text: string) {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), text);
}

const primary = (page: Page) =>
  page.getByRole("navigation", { name: "Primary" });

async function addProject(page: Page) {
  await primary(page).getByRole("link", { name: "Projects" }).click();
  await page.getByRole("button", { name: "Add project folder" }).click();
  await expect(page.getByText("Open now")).toBeVisible();
}

const noteList = (page: Page) =>
  page.getByRole("navigation", { name: "Notes in this project" });

async function openNote(page: Page, name = "Plan.md") {
  await addProject(page);
  await primary(page).getByRole("link", { name: "Notes" }).click();
  await noteList(page).getByRole("link", { name }).click();
  await expect(page.locator(".cm-content")).toBeVisible();
}

/** Starts a frame as the app does, and waits until it says it is ready. */
async function startFrame(page: Page): Promise<Frame> {
  // The page has finished loading, or this would be lost when it does.
  await expect(primary(page)).toBeVisible();
  const ready = await page.evaluate(
    (address) =>
      new Promise<string>((done) => {
        const frame = document.createElement("iframe");
        frame.id = "test-frame";
        frame.setAttribute("sandbox", "allow-scripts");
        frame.style.position = "fixed";
        frame.style.left = "-10000px";
        frame.style.width = "1000px";
        frame.style.height = "800px";
        const giveUp = setTimeout(() => {
          done("no answer");
        }, 30_000);
        const heard = (event: MessageEvent<{ kind?: string }>) => {
          if (
            event.source === frame.contentWindow &&
            event.data.kind === "ready"
          ) {
            clearTimeout(giveUp);
            window.removeEventListener("message", heard);
            done("ready");
          }
        };
        window.addEventListener("message", heard);
        frame.src = address;
        document.body.append(frame);
      }),
    FRAME_ADDRESS,
  );
  expect(ready).toBe("ready");
  const frame = page
    .frames()
    .find((each) => each.url().startsWith("http://liurium-diagram.localhost"));
  if (frame === undefined) {
    throw new Error("the frame is not among the page's frames");
  }
  return frame;
}

interface Drawn {
  kind: string;
  svg?: string;
  width?: number;
  height?: number;
  reason?: string;
}

const draw = (page: Page, id: number, source: string) =>
  page.evaluate(
    ([number, text]) =>
      new Promise<Drawn>((done) => {
        const frame = document.querySelector<HTMLIFrameElement>("#test-frame");
        const heard = (event: MessageEvent<{ id?: number } & Drawn>) => {
          if (
            event.source === frame?.contentWindow &&
            event.data.id === number
          ) {
            window.removeEventListener("message", heard);
            done(event.data);
          }
        };
        window.addEventListener("message", heard);
        frame?.contentWindow?.postMessage(
          { id: number, source: text, look: { dark: true, colors: {} } },
          "*",
        );
      }),
    [id, source] as const,
  );

/** Shows an answer as the app does: a `blob:` address in an image. */
const showAsImage = (page: Page, svg: string) =>
  page.evaluate(
    (text) =>
      new Promise<string>((done) => {
        const image = document.createElement("img");
        image.onload = () => {
          done(`${String(image.naturalWidth)}x${String(image.naturalHeight)}`);
        };
        image.onerror = () => {
          done("failed");
        };
        image.src = URL.createObjectURL(
          new Blob([text], { type: "image/svg+xml" }),
        );
      }),
    svg,
  );

const FLOWCHART = `flowchart TD
  A[Start here] --> B{Is it working?}
  B -->|Yes| C[Keep going<br/>second line]`;

const blocked = (said: readonly string[]) =>
  said.filter((text) => text.includes("Content Security Policy"));

const shownImages = (page: Page) => page.locator(".cm-diagram img");

async function pictureDrew(page: Page) {
  await expect(shownImages(page)).toHaveCount(1);
  await expect
    .poll(() =>
      shownImages(page).evaluate(
        (image) => (image as HTMLImageElement).naturalWidth,
      ),
    )
    .toBeGreaterThan(0);
}

test("a frame loads through its protocol and its pictures show under the app's CSP", async ({
  app,
}) => {
  const page = await app.launch();
  const said: string[] = [];
  page.on("console", (message) => said.push(message.text()));
  await startFrame(page);

  const answer = await draw(page, 1, FLOWCHART);
  expect(answer.kind).toBe("drawn");
  expect(answer.width).toBeGreaterThan(0);
  expect(answer.svg).toContain("Start here");
  expect(await showAsImage(page, answer.svg ?? "")).toBe(
    `${String(answer.width)}x${String(answer.height)}`,
  );

  const sequence = await draw(page, 2, "sequenceDiagram\n  Alice->>Bob: Hello");
  expect(sequence.kind).toBe("drawn");

  const broken = await draw(page, 3, "flowchart TD\n  A[");
  expect(broken.kind).toBe("failed");
  expect(broken.reason).not.toBe("");

  expect(blocked(said)).toEqual([]);
});

test("the frame has no way to the app's commands, its data, or outside", async ({
  app,
}) => {
  const folder = app.folder("Diagrams-");
  const page = await app.launch({ pick: folder });
  const said: string[] = [];
  page.on("console", (message) => said.push(message.text()));
  await addProject(page);
  const frame = await startFrame(page);

  const inFrame = await frame.evaluate(async () => {
    const wide = window as unknown as Record<string, unknown> & {
      chrome?: { webview?: unknown };
    };
    const tried = (work: () => string) => {
      try {
        return work();
      } catch (reason) {
        return `refused: ${(reason as Error).name}`;
      }
    };
    const reached = (address: string, init?: RequestInit) =>
      fetch(address, init).then(
        () => "reached",
        () => "refused",
      );
    return {
      origin: self.origin,
      frozen: Object.isFrozen(Object.prototype),
      internals: typeof wide.__TAURI_INTERNALS__,
      ipc: typeof wide.ipc,
      webview: typeof wide.chrome?.webview,
      parent: tried(() => window.parent.document.title),
      cookie: tried(() => document.cookie),
      storage: tried(() => String(localStorage.length)),
      ipcFetch: await reached("http://ipc.localhost/app_info", {
        method: "POST",
        body: "{}",
      }),
      imageFetch: await reached("http://liurium-image.localhost/x/y.png"),
    };
  });
  expect(inFrame).toMatchObject({
    origin: "null",
    frozen: false,
    parent: "refused: SecurityError",
    cookie: "refused: SecurityError",
    storage: "refused: SecurityError",
    ipcFetch: "refused",
    imageFetch: "refused",
  });

  // On Windows Tauri's scripts also run in a frame, so the frame may hold the app's
  // own way of calling commands. Whatever it says, the note must not appear.
  const asked = await frame.evaluate(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__?: {
          invoke: (command: string, args: object) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    if (internals === undefined) {
      return "no way to ask";
    }
    return Promise.race([
      internals.invoke("create_note", { folder: "", name: "From frame" }).then(
        () => "answered",
        () => "refused",
      ),
      new Promise<string>((done) => {
        setTimeout(() => {
          done("no answer");
        }, 3_000);
      }),
    ]);
  });
  expect(existsSync(join(folder, "From frame.md"))).toBe(false);
  expect(asked).not.toBe("answered");
  if (inFrame.internals === "object") {
    // Its first way was refused, so it really took its second way too.
    expect(
      said.some((text) => text.includes("IPC custom protocol failed")),
    ).toBe(true);
  }

  // The other side: from the page all of this works, so the results above mean something.
  const inPage = await page.evaluate(async () => {
    const internals = (
      window as unknown as {
        __TAURI_INTERNALS__: {
          invoke: (command: string, args: object) => Promise<unknown>;
        };
      }
    ).__TAURI_INTERNALS__;
    return {
      frozen: Object.isFrozen(Object.prototype),
      ipcFetch: await fetch("http://ipc.localhost/app_info", {
        method: "POST",
        body: "{}",
      }).then(
        () => "reached",
        () => "refused",
      ),
      made: await internals.invoke("create_note", {
        folder: "",
        name: "From page",
      }),
    };
  });
  expect(inPage).toMatchObject({ frozen: true, ipcFetch: "reached" });
  expect(existsSync(join(folder, "From page.md"))).toBe(true);

  test.info().annotations.push({
    type: "what a frame has in WebView2",
    description: JSON.stringify({ ...inFrame, asked }),
  });
});

test("the frame runs no inline script, event handler, or generated code", async ({
  app,
}) => {
  const page = await app.launch();
  const frame = await startFrame(page);
  const inline = await frame.evaluate(async () => {
    const script = document.createElement("script");
    script.textContent = "window.ranInline = true";
    document.body.append(script);
    const label = document.createElement("img");
    label.setAttribute("onerror", "window.ranHandler = true");
    label.src = "http://liurium-image.localhost/none.png";
    document.body.append(label);
    await new Promise((done) => setTimeout(done, 300));
    const wide = window as unknown as Record<string, unknown>;
    let made = "ran";
    try {
      // eslint-disable-next-line @typescript-eslint/no-implied-eval -- what the CSP must refuse.
      (new Function("return 1") as () => number)();
    } catch (reason) {
      made = (reason as Error).name;
    }
    return {
      inline: wide.ranInline ?? false,
      handler: wide.ranHandler ?? false,
      made,
    };
  });
  // The frame's own module scripts did run, or it would not have said it was ready.
  expect(inline).toEqual({ inline: false, handler: false, made: "EvalError" });
});

test("a slow frame leaves the page free, and a new one takes over when it ends", async ({
  app,
}) => {
  const page = await app.launch();
  const frame = await startFrame(page);
  await page.evaluate(() => {
    const wide = window as unknown as { gaps: number[] };
    wide.gaps = [];
    let last = performance.now();
    setInterval(() => {
      const now = performance.now();
      wide.gaps.push(now - last);
      last = now;
    }, 20);
  });

  // Not awaited yet: this keeps the frame busy, as an expensive diagram would.
  const busy = frame
    .evaluate(() => {
      const end = performance.now() + 4_000;
      while (performance.now() < end) {
        // Nothing but being busy.
      }
    })
    .catch(() => undefined);

  await page.waitForTimeout(1_500);
  const gaps = await page.evaluate(
    () => (window as unknown as { gaps: number[] }).gaps,
  );
  // About 75 ticks when nothing holds the page up.
  expect(gaps.length).toBeGreaterThan(40);
  expect(Math.max(...gaps)).toBeLessThan(500);

  await page.evaluate(() => {
    document.querySelector("#test-frame")?.remove();
  });
  await busy;

  await startFrame(page);
  expect((await draw(page, 1, FLOWCHART)).kind).toBe("drawn");
});

test("a mermaid block shows as a picture, its source returns at the cursor, the file stays", async ({
  app,
}) => {
  const folder = app.folder("Diagrams-");
  const before =
    "before\r\n\r\n```mermaid\r\nflowchart TD\r\n  A[Start here] --> B[End]\r\n```\r\n\r\nafter\r\n";
  write(folder, "Plan.md", before);
  const page = await app.launch({ pick: folder });
  const said: string[] = [];
  page.on("console", (message) => said.push(message.text()));
  await openNote(page);
  const content = page.locator(".cm-content");

  await pictureDrew(page);
  const image = shownImages(page);
  await expect(image).toHaveAttribute("alt", /^Diagram/);
  await expect(image).toHaveAttribute("src", /^blob:/);
  // A width of its own, so the text below does not jump.
  await expect(image).toHaveAttribute("width", /^[1-9]/);
  await expect(page.locator(".cm-diagram-error")).toHaveCount(0);
  await expect(content).not.toContainText("flowchart");
  // The frame stays out of the way of the keyboard and a screen reader.
  await expect(page.locator("iframe")).toHaveCount(1);
  await expect(page.locator("iframe")).toHaveAttribute(
    "sandbox",
    "allow-scripts",
  );
  await expect(page.locator("iframe")).toHaveAttribute("aria-hidden", "true");

  await image.click();
  await expect(shownImages(page)).toHaveCount(0);
  await expect(content).toContainText("flowchart TD");
  await expect(content).toContainText("```mermaid");

  // Away, and back in with the arrow keys.
  await content.getByText("before").click();
  await pictureDrew(page);
  await page.keyboard.press("ArrowDown");
  await expect(shownImages(page)).toHaveCount(1);
  await page.keyboard.press("ArrowDown");
  await expect(shownImages(page)).toHaveCount(0);
  await content.getByText("before").click();
  await pictureDrew(page);

  expect(blocked(said)).toEqual([]);
  expect(readFileSync(join(folder, "Plan.md"), "utf8")).toBe(before);
});

test("what cannot be drawn says why, a note without a diagram starts nothing", async ({
  app,
}) => {
  const folder = app.folder("Diagrams-");
  write(folder, "Plan.md", "```js\nconst a = 1;\n```\n\nend\n");
  const broken = "```mermaid\nflowchart TD\n  A[\n```\n\nend\n";
  write(folder, "Broken.md", broken);
  write(
    folder,
    "Nested.md",
    "- ```mermaid\n  flowchart TD\n  ```\n\n> ```mermaid\n> pie\n> ```\n",
  );
  const page = await app.launch({ pick: folder });
  await openNote(page);
  await expect(page.locator(".cm-content")).toContainText("end");
  await expect(page.locator("iframe")).toHaveCount(0);

  await noteList(page).getByRole("link", { name: "Nested.md" }).click();
  await expect(page.locator(".cm-content")).toContainText("flowchart TD");
  await expect(page.locator(".cm-diagram")).toHaveCount(0);
  await expect(page.locator("iframe")).toHaveCount(0);

  await noteList(page).getByRole("link", { name: "Broken.md" }).click();
  const error = page.locator(".cm-diagram-error");
  await expect(error).toContainText("flowchart TD");
  await expect(error).toHaveAttribute("title", /^Diagram not shown: /);
  await expect(shownImages(page)).toHaveCount(0);
  expect(readFileSync(join(folder, "Broken.md"), "utf8")).toBe(broken);
});

test("a hostile diagram runs nothing and asks nothing from outside", async ({
  app,
}) => {
  test.setTimeout(120_000);
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

    const pwn = (name: string) => `document.title='pwned-${name}'`;
    const hostile = [
      `flowchart TD\n  A["<img src=${spy}/h1 onerror=${pwn("1")}>"] --> B["<script>${pwn("1b")}</script>x"]`,
      `flowchart TD\n  A[go] --> B[x]\n  click A "javascript:${pwn("2")}"\n  click B href "${spy}/h2b"`,
      `%%{init:{"securityLevel":"loose","startOnLoad":true}}%%\nflowchart TD\n  A["<img src=${spy}/h3 onerror=${pwn("3")}>"] --> B\n  click B call alert("h3b")`,
      `%%{init:{"themeCSS":"@import url(${spy}/h4); .node rect{fill:url(${spy}/h4b)}"}}%%\nflowchart TD\n  A --> B`,
      `%%{init:{"fontFamily":"x;}@import url(${spy}/h5);.y{"}}%%\nflowchart TD\n  A --> B`,
      `sequenceDiagram\n  participant A\n  A->>A: <img src=${spy}/h7 onerror=${pwn("7")}>\n  Note over A: <iframe src=${spy}/h7b></iframe>\n  link A: Dash @ javascript:${pwn("7c")}\n  link A: Out @ ${spy}/h7d`,
      `flowchart TD\n  A@{ img: "${spy}/h9", label: "x", pos: "t", w: 60, h: 60, constraint: "off" }`,
      `flowchart TD\n  A["\`![x](${spy}/h10) **b**\`"] --> B["\`<img src=${spy}/h10b>\`"]`,
      `flowchart TD\n  A["$$\\href{javascript:${pwn("11")}}{x}$$"] --> B["$$\\includegraphics{${spy}/h11b}$$"]`,
      `flowchart TD\n  A["fa:fa-book <svg onload=${pwn("12")}></svg>"] --> B`,
      `architecture-beta\n  service db(logos:aws-lambda)[Database]`,
      `classDiagram\n  class A["<foreignObject><iframe src=${spy}/h14></iframe></foreignObject>"]\n  link A "javascript:${pwn("14b")}"\n  click A href "${spy}/h14c"`,
      `---\nconfig:\n  securityLevel: loose\n  themeCSS: "@import url(${spy}/h15);"\n  htmlLabels: true\n---\nflowchart TD\n  A["<img src=${spy}/h15b onerror=${pwn("15c")}>"]`,
    ];
    const folder = app.folder("Diagrams-");
    write(folder, "Plan.md", "start\n");
    const texts = hostile.map((each, index) => {
      const name = `Hostile ${String(index + 1)}.md`;
      const text = `\`\`\`mermaid\n${each}\n\`\`\`\n\nend\n`;
      write(folder, name, text);
      return { name, text };
    });
    const page = await app.launch({ pick: folder });
    let dialogs = 0;
    page.on("dialog", (dialog) => {
      dialogs += 1;
      void dialog.dismiss();
    });
    await openNote(page);

    // A note each, as only what is in view draws: this cannot pass by showing nothing.
    let pictures = 0;
    for (const { name, text } of texts) {
      await noteList(page).getByRole("link", { name, exact: true }).click();
      const done = page.locator(".cm-diagram img, .cm-diagram-error");
      await expect(done).toHaveCount(1, { timeout: 15_000 });
      pictures += await shownImages(page).count();
      expect(readFileSync(join(folder, name), "utf8")).toBe(text);
    }
    // Most of them drew, so what they hold really went through Mermaid.
    expect(pictures).toBeGreaterThan(hostile.length / 2);
    // Give anything that would have started the time to arrive.
    await page.waitForTimeout(1_000);

    expect(requests).toEqual([]);
    expect(dialogs).toBe(0);
    expect(await page.title()).toBe("Liurium");
    await expect(page.locator(".cm-content")).toContainText("end");
  } finally {
    server.close();
  }
});

test("a diagram follows the mode, and one drawn before shows at once", async ({
  app,
}) => {
  const folder = app.folder("Diagrams-");
  write(folder, "Plan.md", "```mermaid\nflowchart TD\n  A --> B\n```\n\nend\n");
  const page = await app.launch({ pick: folder });
  await openNote(page);
  await pictureDrew(page);
  const first = await shownImages(page).getAttribute("src");
  const mode = await page.evaluate(() => document.documentElement.dataset.mode);
  const other = mode === "light" ? "dark" : "light";

  await page.evaluate((next) => {
    document.documentElement.dataset.mode = next;
  }, other);
  await expect
    .poll(() => shownImages(page).getAttribute("src"))
    .not.toBe(first);
  await pictureDrew(page);

  await page.evaluate((next) => {
    document.documentElement.dataset.mode = next;
  }, mode ?? "dark");
  await expect.poll(() => shownImages(page).getAttribute("src")).toBe(first);
});
