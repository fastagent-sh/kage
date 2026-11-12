import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import electron from "electron";

export async function checkPanelLayout(win, { evaluate, until, type }) {
  const { nativeTheme } = electron;
  const initialSize = win.getSize();
  const initialZoom = win.webContents.getZoomFactor();
  const initialTheme = nativeTheme.themeSource;
  const initialDraft = await evaluate("document.querySelector('textarea[aria-label=Message]').value");
  const shots = process.env.KAGE_LAYOUT_SHOTS === "1";
  const folder = fileURLToPath(new URL("../out/layout-shots/", import.meta.url));
  if (shots) await mkdir(folder, { recursive: true });
  const settle = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const press = (keyCode) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  const openDetails = async () => {
    await evaluate(`(() => { const button = document.querySelector('main > header .drag > button'); button.focus(); button.click(); })()`);
    await until("!!document.querySelector('#agent-info')", "Agent details opens");
    await settle();
  };
  const geometry = () => evaluate(`(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector), r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth },
      main: rect('main'), header: rect('.conversation-header'),
      input: rect('textarea[aria-label=Message]'), composer: rect('.composer'),
      transcript: rect('[aria-label="Transcript"]'),
      lineHeight: parseFloat(getComputedStyle(document.querySelector('textarea')).lineHeight),
      inputPadding: parseFloat(getComputedStyle(document.querySelector('textarea')).paddingTop) + parseFloat(getComputedStyle(document.querySelector('textarea')).paddingBottom),
    };
  })()`);
  const hit = (selector) => evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)}), r = el.getBoundingClientRect();
    const target = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return r.width > 0 && r.height > 0 && el.contains(target);
  })()`);
  const readable = (result, label) => {
    assert.ok(result.input.width >= 160, `${label}: the input needs usable width, got ${result.input.width}`);
    assert.ok(result.header.scrollWidth <= result.header.clientWidth + 1, `${label}: header controls overflow`);
    assert.ok(result.viewport.pageWidth <= result.viewport.width + 1, `${label}: page overflows`);
    assert.ok(result.header.bottom <= result.input.top, `${label}: the editor overlaps the header`);
    assert.ok(result.composer.bottom <= result.viewport.height, `${label}: composer leaves the window`);
  };
  const wholeLines = (result, label) => {
    const contentHeight = result.input.height - result.inputPadding;
    const lines = Math.round(contentHeight / result.lineHeight);
    assert.ok(lines >= 1 && Math.abs(contentHeight - lines * result.lineHeight) <= 1, `${label}: draft ends on a complete text line (height ${result.input.height}, padding ${result.inputPadding}, line ${result.lineHeight})`);
    assert.ok(result.input.scrollHeight > result.input.height, `${label}: longer drafts remain scrollable`);
  };
  const capture = async (name) => {
    if (!shots) return;
    await evaluate("document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).forEach(animation => animation.finish())");
    await writeFile(`${folder}${name}.png`, (await win.webContents.capturePage()).toPNG());
  };

  try {
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      for (const [width, height] of [[1180, 860], [800, 540]]) {
        for (const zoom of [1, 1.5, 2]) {
          win.setSize(width, height);
          win.webContents.setZoomFactor(zoom);
          await type("");
          await settle();
          const label = `${width}-${zoom * 100}-${theme}`;
          const closed = await geometry();
          readable(closed, `${label} closed`);
          await openDetails();
          const opened = await evaluate(`(() => {
            const rect = (selector) => { const el = document.querySelector(selector), r = el.getBoundingClientRect(); return { left: r.left, right: r.right, width: r.width, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth }; };
            return { viewport: { width: innerWidth }, main: rect('main'), profile: rect('#agent-info') };
          })()`);
          assert.ok(opened.profile.left >= 0 && opened.profile.right <= opened.viewport.width, `${label}: details fits horizontally`);
          assert.ok(opened.profile.scrollWidth <= opened.profile.clientWidth + 1, `${label}: details does not overflow sideways`);
          assert.ok(Math.abs(closed.main.width - opened.main.width) < 1, `${label}: details takes the conversation's place`);
          assert.ok(await hit('#agent-info button[aria-label="Close agent details"]'), `${label}: details can be closed`);
          await capture(`${label}-details`);
          await evaluate(`document.querySelector('#agent-info button[aria-label="Close agent details"]').click()`);
          await until("!document.querySelector('#agent-info')", "details closes");
          await settle();
          assert.equal(await evaluate("document.activeElement.matches('main > header .drag > button')"), true, `${label}: focus returns to the opener`);
          await type(Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1}: keep this text with its conversation.`).join("\n"));
          await settle();
          const drafting = await geometry();
          readable(drafting, `${label} long draft`);
          wholeLines(drafting, label);
          if (width === 1180 && zoom === 2) {
            win.setSize(width, 640);
            await settle();
            wholeLines(await geometry(), `${label} resized without typing`);
            win.setSize(width, height);
            await settle();
          }
          assert.ok(drafting.transcript.height >= drafting.lineHeight * 2, `${label}: long drafts must leave two readable lines, got ${drafting.transcript.height}`);
          assert.equal(await evaluate("document.querySelector('button[aria-label=\"Send\"]').getAttribute('aria-disabled')"), null, `${label}: the draft can be sent`);
          assert.ok(await hit('button[aria-label="Send"]'), `${label}: Send remains reachable`);
          await capture(`${label}-draft`);
          if (width === 1180 && zoom === 2) {
            const draft = await evaluate("document.querySelector('textarea').value");
            await evaluate("document.querySelector('textarea').select()");
            await win.webContents.insertText(`${draft}\nNative insertion at the end.`);
            win.webContents.sendInputEvent({ type: "keyDown", keyCode: "X" });
            win.webContents.sendInputEvent({ type: "char", keyCode: "x" });
            win.webContents.sendInputEvent({ type: "keyUp", keyCode: "X" });
            await until("document.querySelector('textarea').value.endsWith('Native insertion at the end.x')", "native insertion and typing preserve the draft");
            await settle();
            await capture(`${label}-native-input`);
            const caret = await evaluate(`(() => { const el = document.querySelector('textarea'), style = getComputedStyle(el); return { atEnd: el.selectionEnd === el.value.length, bottom: el.scrollHeight - el.scrollTop - el.clientHeight, lineHeight: parseFloat(style.lineHeight), fontSize: parseFloat(style.fontSize), paddingBottom: parseFloat(style.paddingBottom) }; })()`);
            // Caret scrolling aligns the glyphs, not necessarily the bottom of their line box.
            const trailingSpace = (caret.lineHeight - caret.fontSize) / 2 + caret.paddingBottom;
            assert.ok(caret.atEnd && caret.bottom <= trailingSpace + 1, `continued native input keeps the caret's final line visible: ${JSON.stringify(caret)}`);
          }
          if (closed.viewport.width <= 640) {
            await evaluate(`(() => { const button = document.querySelector('button[title^="Model for this agent"]'); button.focus(); button.click(); })()`);
            await until("!!document.querySelector('dialog[open]')", "model picker opens at zoom");
            assert.ok(await evaluate(`(() => { const r = document.querySelector('dialog[open]').getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; })()`), `${label}: model picker stays inside the window`);
            press("Escape");
            await until("!document.querySelector('dialog[open]')", "model picker closes");
            await evaluate(`(() => { const button = document.querySelector('button[aria-label="Show agents"]'); button.focus(); button.click(); })()`);
            await until("document.querySelector('.sidebar-panel').matches(':popover-open')", "compact Agents opens");
            assert.ok(await hit('aside button[aria-current="true"]'), `${label}: the current Agent is reachable`);
            press("Escape");
            await until("!document.querySelector('.sidebar-panel').matches(':popover-open')", "Escape closes compact Agents");
            assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Show agents");
            assert.match(await evaluate("document.querySelector('textarea').value"), /Draft line 12/, "opening Agents does not lose the draft");
          }
        }
      }
    }

    win.setSize(1180, 860);
    win.webContents.setZoomFactor(1);
    await type("");
    await settle();
    await openDetails();
    win.webContents.setZoomFactor(1.5);
    await settle();
    assert.ok(await hit('#agent-info button[aria-label="Close agent details"]'), "open details survives a zoom change");
    press("Escape");
    await until("!document.querySelector('#agent-info')", "Escape closes details");
  } finally {
    nativeTheme.themeSource = initialTheme;
    win.setSize(...initialSize);
    win.webContents.setZoomFactor(initialZoom);
    await type(initialDraft);
  }
  console.log("Panel layout passed: light/dark, 800/1180px, 100/150/200%, long drafts and live panel resizing.");
}

export async function checkUsagePopoverLayout(win, { evaluate, until }) {
  const { nativeTheme } = electron;
  const initialSize = win.getSize();
  const initialZoom = win.webContents.getZoomFactor();
  const initialTheme = nativeTheme.themeSource;
  const folder = fileURLToPath(new URL("../out/layout-shots/", import.meta.url));
  try {
    for (const theme of ["light", "dark"]) {
      nativeTheme.themeSource = theme;
      for (const [width, height] of [[1180, 860], [800, 540]]) {
        for (const zoom of [1, 1.5, 2]) {
          win.setSize(width, height);
          win.webContents.setZoomFactor(zoom);
          await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          const { root } = await win.webContents.debugger.sendCommand("DOM.getDocument");
          const { nodeId } = await win.webContents.debugger.sendCommand("DOM.querySelector", { nodeId: root.nodeId, selector: 'header [aria-label="Usage"]' });
          await win.webContents.debugger.sendCommand("CSS.enable");
          // Window resizing can move the OS pointer; fix only the pseudo state while measuring geometry.
          for (const mode of ["hover", "focus-visible"]) {
            await win.webContents.debugger.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [mode] });
            await until("getComputedStyle(document.querySelector('header [aria-label=Usage] .popover').parentElement).opacity === '1'", `${width}-${zoom * 100}-${theme}: usage is visible on ${mode}`);
            const bounds = await evaluate(`(() => {
              const panel = document.querySelector('header [aria-label=Usage] .popover');
              const outside = [panel, ...panel.querySelectorAll('span')].filter(element => {
                const r = element.getBoundingClientRect();
                return r.left < 0 || r.right > innerWidth || r.top < 0 || r.bottom > innerHeight;
              }).map(element => ({ text: element.textContent, left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right }));
              return { text: panel.textContent, outside };
            })()`);
            assert.match(bounds.text, /5h[\s\S]*4%[\s\S]*7d[\s\S]*18%/, "the fixture includes both subscription windows");
            assert.deepEqual(bounds.outside, [], `${width}-${zoom * 100}-${theme}-${mode}: every usage label and value stays in the viewport`);
            if (mode === "hover") {
              assert.ok(await evaluate(`(() => {
                const panel = document.querySelector('header [aria-label=Usage] .popover');
                const back = document.querySelector('button[aria-label="Back to the latest"]');
                if (!back) return true;
                const p = panel.getBoundingClientRect(), r = back.getBoundingClientRect();
                const x = r.left + r.width / 2, y = r.top + r.height / 2;
                return x < p.left || x > p.right || y < p.top || y > p.bottom || panel.contains(document.elementFromPoint(x, y));
              })()`), `${width}-${zoom * 100}-${theme}: transcript controls do not cover the usage table`);
            }
            if (process.env.KAGE_LAYOUT_SHOTS === "1" && zoom === 2 && mode === "hover") {
              await mkdir(folder, { recursive: true });
              await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
              await writeFile(`${folder}${width}-200-${theme}-usage.png`, (await win.webContents.capturePage()).toPNG());
            }
          }
          await win.webContents.debugger.sendCommand("CSS.forcePseudoState", { nodeId, forcedPseudoClasses: [] });
        }
      }
    }
  } finally {
    nativeTheme.themeSource = initialTheme;
    win.setSize(...initialSize);
    win.webContents.setZoomFactor(initialZoom);
    win.webContents.sendInputEvent({ type: "mouseMove", x: 4, y: initialSize[1] - 4 });
    await evaluate("document.querySelector('textarea').focus()");
  }
}

export async function checkAgentPointerRename(win, { evaluate, until, type }, names) {
  const initialSize = win.getSize();
  const initialZoom = win.webContents.getZoomFactor();
  try {
    win.setSize(800, 540);
    for (const zoom of [1, 2]) {
      win.webContents.setZoomFactor(zoom);
      await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
      if (zoom === 2) {
        await evaluate(`document.querySelector('button[aria-label="Show agents"]').click()`);
        await until("document.querySelector('.sidebar-panel').matches(':popover-open')", "Agent roster opens for pointer rename");
      }
      for (const name of names) {
        const point = await evaluate(`(() => {
          const row = document.querySelector('aside button[aria-label="${name}"]');
          const rect = row.getBoundingClientRect();
          window.__renameClicks = [];
          row.addEventListener('click', event => window.__renameClicks.push(event.detail));
          return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        })()`);
        for (const clickCount of [1, 2]) {
          const coordinates = { x: Math.round(point.x * zoom), y: Math.round(point.y * zoom), button: "left", clickCount };
          win.webContents.sendInputEvent({ type: "mouseDown", ...coordinates });
          win.webContents.sendInputEvent({ type: "mouseUp", ...coordinates });
          await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
        }
        await until("!!document.querySelector('aside input[aria-label=\"Agent name\"]')", `${zoom * 100}%: two pointer clicks open rename for ${name}`, { timeout: 1500 });
        assert.deepEqual(await evaluate("window.__renameClicks"), [1, 2], "the first click must leave the target available for the second");
        await type("An unsaved rename", 'aside input[aria-label="Agent name"]');
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await until("!document.querySelector('aside input[aria-label=\"Agent name\"]')", "Escape cancels rename");
        await until(`document.activeElement.getAttribute('aria-label') === ${JSON.stringify(name)}`, "rename returns focus to its row");
        assert.ok(await evaluate(`!!document.querySelector('aside button[aria-label="${name}"]')`), "canceling preserves the Agent name");
        if (zoom === 2) assert.ok(await evaluate("document.querySelector('.sidebar-panel').matches(':popover-open')"), "canceling rename keeps the roster open");
      }
      if (zoom === 2) {
        win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
        win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
        await until("document.querySelector('button[aria-label=\"Show agents\"]').getAttribute('aria-expanded') === 'false'", "a second Escape closes the roster");
        assert.equal(await evaluate("document.querySelector('.sidebar-panel').matches(':popover-open')"), false);
      }
    }
  } finally {
    win.setSize(...initialSize);
    win.webContents.setZoomFactor(initialZoom);
    await evaluate("delete window.__renameClicks");
  }
}

export async function checkCompactSettings(win, { evaluate, until }) {
  const initialSize = win.getSize();
  const initialZoom = win.webContents.getZoomFactor();
  win.setSize(800, 540);
  win.webContents.setZoomFactor(2);
  try {
    await until("!!document.querySelector('button[aria-label=\"Show agents\"]')", "compact navigation is available in Settings");
    await evaluate(`document.querySelector('button[aria-label="Show agents"]').click()`);
    await until("document.querySelector('.sidebar-panel').matches(':popover-open')", "Agent roster opens above Settings");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until("!document.querySelector('.sidebar-panel').matches(':popover-open')", "Escape closes the Agent roster");
    assert.ok(await evaluate("!!document.querySelector('#network-heading')"), "dismissing Agents must not also leave Settings");
  } finally {
    win.setSize(...initialSize);
    win.webContents.setZoomFactor(initialZoom);
  }
}

export async function checkConcurrentHeaderLayout(win, { evaluate, until }) {
  const initialSize = win.getSize();
  const initialZoom = win.webContents.getZoomFactor();
  const initialTheme = electron.nativeTheme.themeSource;
  const folder = fileURLToPath(new URL("../out/layout-shots/", import.meta.url));
  try {
    for (const theme of ["light", "dark"]) {
      electron.nativeTheme.themeSource = theme;
      for (const [width, height] of [[1180, 860], [800, 540]]) {
        for (const zoom of [1, 1.5, 2]) {
          win.setSize(width, height);
          win.webContents.setZoomFactor(zoom);
          await until(`document.querySelector('.workbench').hasAttribute('data-compact') === (innerWidth <= 640)`, "concurrent header reflows");
          await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          const layout = await evaluate(`(() => {
            const header = document.querySelector('.conversation-header');
            const fits = element => { const r = element.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight; };
            const reachable = selector => {
              const element = document.querySelector(selector), r = element.getBoundingClientRect();
              return fits(element) && element.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
            };
            return {
              fits: document.documentElement.scrollWidth <= innerWidth && header.scrollWidth <= header.clientWidth + 1 && [...header.children].every(fits),
              other: reachable('button[title="Show the conversations that are working"]'),
              stop: reachable('button[aria-label="Stop the run"]'),
              identity: document.querySelector('header .drag > button').getBoundingClientRect().width,
            };
          })()`);
          const name = `concurrent-${width}-${zoom * 100}-${theme}`;
          assert.ok(layout.fits && layout.other && layout.stop, `${name}: header, other runs and Stop fit and remain reachable: ${JSON.stringify(layout)}`);
          assert.ok(layout.identity >= 40, `${name}: the Agent name retains visible space`);
          if (process.env.KAGE_LAYOUT_SHOTS === "1") {
            await mkdir(folder, { recursive: true });
            await evaluate("document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).forEach(animation => animation.finish())");
            await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
            await writeFile(`${folder}${name}.png`, (await win.webContents.capturePage()).toPNG());
          }
        }
      }
    }
  } finally {
    win.setSize(...initialSize);
    win.webContents.setZoomFactor(initialZoom);
    electron.nativeTheme.themeSource = initialTheme;
  }
}

export async function checkGuidanceLayout(win, { evaluate, until }, state) {
  const initialSize = win.getSize();
  const initialZoom = win.webContents.getZoomFactor();
  const initialTheme = electron.nativeTheme.themeSource;
  const folder = fileURLToPath(new URL("../out/layout-shots/", import.meta.url));
  try {
    for (const theme of ["light", "dark"]) {
      electron.nativeTheme.themeSource = theme;
      for (const [width, height] of [[1180, 860], [800, 540]]) {
        for (const zoom of [1, 1.5, 2]) {
          win.setSize(width, height);
          win.webContents.setZoomFactor(zoom);
          await until("document.querySelector('.workbench').hasAttribute('data-compact') === (innerWidth <= 640)", "guidance reflows");
          await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
          const result = await evaluate(`(() => {
            const page = document.querySelector('.conversation-start, .problem-page');
            const scroll = page.matches('.conversation-start') ? page.parentElement : page;
            const visible = button => {
              const r = button.getBoundingClientRect();
              return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && button.contains(document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2));
            };
            const firstAction = page.querySelector('button');
            const firstActionVisible = firstAction !== null && visible(firstAction);
            const reachable = [...page.querySelectorAll('button')].map(button => {
              button.blur();
              button.focus();
              return { label: button.textContent.trim(), fits: visible(button) };
            });
            scroll.scrollTop = 0;
            return { fits: document.documentElement.scrollWidth <= innerWidth && scroll.scrollWidth <= scroll.clientWidth + 1, firstActionVisible, reachable };
          })()`);
          const name = `${state}-${width}-${zoom * 100}-${theme}`;
          assert.ok(result.fits && result.reachable.every(button => button.fits), `${name}: guidance fits and its actions are reachable: ${JSON.stringify(result)}`);
          if (state === "needs-model") assert.ok(result.firstActionVisible, `${name}: the next step is visible without scrolling`);
          if (process.env.KAGE_LAYOUT_SHOTS === "1") {
            await mkdir(folder, { recursive: true });
            await evaluate("document.getAnimations().filter(animation => animation.effect?.getComputedTiming().iterations !== Infinity).forEach(animation => animation.finish())");
            await evaluate("new Promise(resolve => requestAnimationFrame(resolve))");
            await writeFile(`${folder}${name}.png`, (await win.webContents.capturePage()).toPNG());
          }
        }
      }
    }
  } finally {
    win.setSize(...initialSize);
    win.webContents.setZoomFactor(initialZoom);
    electron.nativeTheme.themeSource = initialTheme;
    await until("document.querySelector('.workbench').hasAttribute('data-compact') === (innerWidth <= 640)", "guidance restores the window layout");
    await evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  }
}

export async function checkPanelEscapeDuringRun(win, { evaluate, until }) {
  await evaluate(`(() => { const button = document.querySelector('main > header .drag > button'); button.focus(); button.click(); })()`);
  await until("!!document.querySelector('#agent-info')", "details opens over a running conversation");
  win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
  await until("!document.querySelector('#agent-info')", "Escape closes details");
  assert.ok(await evaluate("!!document.querySelector('button[aria-label=\"Stop the run\"]')"), "closing details does not stop the run");
  await until("document.activeElement.matches('main > header .drag > button')", "focus returns to the opener");
}
