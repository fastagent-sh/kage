// Drives kage's real window: the one place that knows how to open it, wait for it, type into it and read it
// back. Each script keeps its own fixtures, its own waits (they differ on purpose) and what it asserts.
import electron from "electron";

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Opens the app's main process and answers its first window, loaded. `attach` sees the window before it loads. */
export async function open({ size, attach } = {}) {
  const { app } = electron;
  let win;
  const loaded = new Promise((resolve) => {
    app.once("browser-window-created", (_event, window) => {
      win = window;
      attach?.(window);
      window.webContents.once("did-finish-load", resolve);
    });
  });
  await import("../out/main/index.js");
  await loaded;
  if (size) win.setSize(...size);
  return win;
}

// A controlled field ignores a plain assignment: set it through the element's own prototype and fire the event
// React listens for, as Playwright's `fill` does.
const fill = (selector, text) => `(() => {
  const field = document.querySelector(${JSON.stringify(selector)});
  if (!field) throw new Error("Missing field: " + ${JSON.stringify(selector)});
  field.focus();
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(field), "value").set.call(field, ${JSON.stringify(text)});
  field.dispatchEvent(new Event("input", { bubbles: true }));
})()`;

/**
 * The window's reading and driving. `timeout`, `poll` and `dump` are the caller's: `perf` times its waits,
 * `packaged` appends the app's output, the smoke script appends the renderer's console.
 */
export function driver(run, { timeout = 20000, poll = 25, dump } = {}) {
  const evaluate = async (expression) => {
    try {
      return await run(expression);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(dump ? `${message}\n${dump()}` : message);
    }
  };
  const page = () => evaluate("document.querySelector('main')?.innerText ?? document.body.innerText").catch(() => "");
  const until = async (expression, what, { timeout: limit = timeout, poll: every = poll } = {}) => {
    const start = Date.now();
    let last;
    for (; Date.now() - start < limit; await sleep(every)) {
      try {
        if (await run(expression)) return Date.now() - start;
      } catch (error) {
        last = error;
      }
    }
    throw new Error(
      `Timed out: ${what}\n${expression}${last ? `\nlast error: ${last instanceof Error ? last.message : last}` : ""}` +
        `${dump ? `\n${dump()}` : ""}\n${await page()}`,
    );
  };
  const type = (text, selector = "textarea") => evaluate(fill(selector, text));
  const click = (text) =>
    evaluate(`(() => {
    const wanted = ${JSON.stringify(text)};
    const button = [...document.querySelectorAll("button")].find((b) => b.textContent.trim() === wanted || b.firstElementChild?.textContent === wanted);
    if (!button) throw new Error("Missing button: " + wanted);
    button.focus();
    button.click();
  })()`);
  // Send can be pressed once the draft has text, on the render after the input event.
  const send = async (text) => {
    await until("!!document.querySelector('textarea') && !document.querySelector('textarea').disabled", "the composer is ready");
    await type(text);
    await until(`!!document.querySelector('button[aria-label="Send"]:not([aria-disabled])')`, "Send is offered");
    await evaluate(`document.querySelector('button[aria-label="Send"]').click()`);
  };
  return {
    evaluate,
    until,
    type,
    click,
    send,
    text: () => evaluate("document.querySelector('main')?.innerText ?? ''"),
    transcript: () => evaluate(`document.querySelector('[aria-label="Transcript"]')?.innerText ?? ""`),
  };
}

export const windowDriver = (win, options) =>
  driver((expression) => win.webContents.executeJavaScript(expression, true), options);
