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
  const shots = process.env.DUANG_LAYOUT_SHOTS === "1";
  const folder = fileURLToPath(new URL("../out/layout-shots/", import.meta.url));
  if (shots) await mkdir(folder, { recursive: true });
  const settle = () => evaluate("new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  const press = (keyCode) => {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  };
  const openDetails = async () => {
    await evaluate(`(() => { const button = document.querySelector('button[aria-label="Agent details"]'); button.focus(); button.click(); })()`);
    await until("!!document.querySelector('#agent-info')", "Agent details opens");
    await settle();
  };
  const geometry = () => evaluate(`(() => {
    const rect = (selector) => {
      const el = document.querySelector(selector), r = el.getBoundingClientRect();
      return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width, height: r.height, scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
    };
    return {
      viewport: { width: innerWidth, height: innerHeight, pageWidth: document.documentElement.scrollWidth },
      main: rect('main'), header: rect('.conversation-header'),
      input: rect('textarea[aria-label=Message]'), composer: rect('.composer'),
      transcript: rect('[aria-label="Transcript"]'),
      lineHeight: parseFloat(getComputedStyle(document.querySelector('textarea')).lineHeight),
      inspector: document.querySelector('#agent-info') ? rect('#agent-info') : undefined,
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
          const opened = await geometry();
          readable(opened, `${label} open`);
          assert.ok(opened.inspector.left >= 0 && opened.inspector.right <= opened.viewport.width, `${label}: details fits horizontally`);
          assert.ok(opened.inspector.top >= 0 && opened.inspector.bottom <= opened.viewport.height, `${label}: details fits vertically`);
          assert.ok(await hit('#agent-info button[aria-label="Close agent details"]'), `${label}: details can be closed`);
          if (opened.viewport.width > 1080) {
            assert.ok(opened.main.right <= opened.inspector.left, `${label}: wide details stays beside the conversation`);
          } else {
            assert.ok(Math.abs(closed.main.width - opened.main.width) < 1, `${label}: opening details does not squeeze the conversation`);
            assert.equal(await evaluate("document.querySelector('#agent-info').matches(':popover-open')"), true);
          }
          await capture(`${label}-details`);
          await evaluate(`document.querySelector('#agent-info button[aria-label="Close agent details"]').click()`);
          await until("!document.querySelector('#agent-info')", "details closes");
          if (opened.viewport.width <= 1080) {
            assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Agent details", `${label}: focus returns to the opener`);
          }
          await type(Array.from({ length: 12 }, (_, index) => `Draft line ${index + 1}: keep this text with its conversation.`).join("\n"));
          await settle();
          const drafting = await geometry();
          readable(drafting, `${label} long draft`);
          assert.ok(drafting.transcript.height >= drafting.lineHeight * 2, `${label}: long drafts must leave two readable lines, got ${drafting.transcript.height}`);
          assert.equal(await evaluate("document.querySelector('button[aria-label=\"Send\"]').getAttribute('aria-disabled')"), null, `${label}: the draft can be sent`);
          assert.ok(await hit('button[aria-label="Send"]'), `${label}: Send remains reachable`);
          await capture(`${label}-draft`);
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
    await evaluate(`[...document.querySelectorAll('#agent-info button')].find(button => button.textContent.trim() === 'Add variable…').click()`);
    await until("!!document.querySelector('input[aria-label=\"Variable value\"]')", "variable editor opens");
    await type("LAYOUT_TEST", 'input[aria-label="Variable name"]');
    await type("synthetic-unsaved-value", 'input[aria-label="Variable value"]');
    win.webContents.setZoomFactor(1.5);
    await until("document.querySelector('#agent-info').matches(':popover-open')", "existing inspector becomes an overlay");
    assert.equal(await evaluate("document.querySelector('input[aria-label=\"Variable value\"]').value"), "synthetic-unsaved-value", "changing presentation preserves an unsaved form");
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Variable value", "resize preserves the field being edited");
    win.webContents.setZoomFactor(1);
    await until("!document.querySelector('#agent-info').hasAttribute('popover')", "inspector returns to its column");
    assert.equal(await evaluate("document.querySelector('input[aria-label=\"Variable value\"]').value"), "synthetic-unsaved-value");
    win.webContents.setZoomFactor(1.5);
    await until("document.querySelector('#agent-info').matches(':popover-open')", "inspector overlays again");
    press("Escape");
    await until("!document.querySelector('input[aria-label=\"Variable value\"]')", "Escape cancels the unsaved variable");
    assert.ok(await evaluate("document.querySelector('#agent-info').matches(':popover-open')"), "canceling an edit does not dismiss its panel");
    await evaluate(`document.querySelector('#agent-info button[aria-label="Close agent details"]').click()`);
    await until("!document.querySelector('#agent-info')", "inspector closes after resize");
  } finally {
    nativeTheme.themeSource = initialTheme;
    win.setSize(...initialSize);
    win.webContents.setZoomFactor(initialZoom);
    await type(initialDraft);
  }
  console.log("Panel layout passed: light/dark, 800/1180px, 100/150/200%, long drafts and live panel resizing.");
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

export async function checkPanelEscapeDuringRun(win, { evaluate, until }) {
  const initialSize = win.getSize();
  win.setSize(800, 540);
  try {
    await evaluate(`(() => { const button = document.querySelector('button[aria-label="Agent details"]'); button.focus(); button.click(); })()`);
    await until("document.querySelector('#agent-info')?.matches(':popover-open')", "details overlays a running conversation");
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await until("!document.querySelector('#agent-info')", "Escape closes details");
    assert.ok(await evaluate("!!document.querySelector('button[aria-label=\"Stop the run\"]')"), "closing details does not stop the run");
    assert.equal(await evaluate("document.activeElement.getAttribute('aria-label')"), "Agent details");
    await evaluate(`document.querySelector('button[aria-label="Agent details"]').click()`);
    await until("document.querySelector('#agent-info')?.matches(':popover-open')", "details reopens");
    const withoutBlur = await evaluate(`(() => {
      const panel = document.querySelector('#agent-info');
      const block = (event) => event.stopPropagation();
      panel.addEventListener('focusout', block, true);
      document.querySelector('button[aria-label="Stop the run"]').focus();
      const stillOpen = panel.matches(':popover-open');
      panel.removeEventListener('focusout', block, true);
      panel.querySelector('button').focus();
      return stillOpen;
    })()`);
    assert.ok(withoutBlur, "without the focus-out handler, native popovers can cover controls reached by keyboard");
    await evaluate(`document.querySelector('button[aria-label="Stop the run"]').focus()`);
    await until("!document.querySelector('#agent-info')", "moving focus outside dismisses details");
    assert.ok(await evaluate("!!document.querySelector('button[aria-label=\"Stop the run\"]')"), "focus changes do not stop the run");
  } finally {
    win.setSize(...initialSize);
  }
}
