import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const plain = (value) => JSON.parse(JSON.stringify(value));

async function loadLauncher() {
  const source = await readFile(new URL("../extension/diffy-launcher.js", import.meta.url), "utf8");
  const context = { globalThis: {}, Math, Object, queueMicrotask };
  context.globalThis = context;
  vm.runInNewContext(source, context);
  return context.DiffyLauncher;
}

test("drag points clamp inside the visible viewport", async () => {
  const { clampPoint } = await loadLauncher();
  assert.deepEqual(plain(clampPoint({ x: -50, y: 999 }, { width: 400, height: 300 }, 62, 12)), {
    x: 12,
    y: 226,
  });
});

test("drop snaps to the nearest edge while preserving the other axis", async () => {
  const { snapPoint } = await loadLauncher();
  assert.deepEqual(plain(snapPoint({ x: 180, y: 19 }, { width: 400, height: 300 }, 62, 12)), {
    x: 180,
    y: 12,
    edge: "top",
  });
  assert.deepEqual(plain(snapPoint({ x: 390, y: 130 }, { width: 400, height: 300 }, 62, 12)), {
    x: 326,
    y: 130,
    edge: "right",
  });
});

test("click-vs-drag threshold does not accidentally open after movement", async () => {
  const { isClick, createDragController } = await loadLauncher();
  assert.equal(isClick({ x: 10, y: 10 }, { x: 14, y: 13 }, 7), true);
  assert.equal(isClick({ x: 10, y: 10 }, { x: 18, y: 10 }, 7), false);
  const events = [];
  const controller = createDragController({
    threshold: 7,
    onClick: () => events.push("click"),
    onDrop: () => events.push("drop"),
  });
  controller.down({ pointerId: 1, clientX: 10, clientY: 10 }, { x: 100, y: 100 });
  assert.equal(controller.up({ pointerId: 1, clientX: 22, clientY: 10 }, { x: 112, y: 100 }), "drag");
  assert.deepEqual(events, ["drop"]);
});

test("sub-threshold pointer jitter clicks without displacing the launcher", async () => {
  const { createDragController } = await loadLauncher();
  const events = [];
  const controller = createDragController({
    threshold: 7,
    onMove: (point) => events.push(["move", point]),
    onClick: () => events.push(["click"]),
  });
  controller.down(
    { pointerId: 1, clientX: 10, clientY: 10 },
    { x: 100, y: 100 }
  );
  assert.deepEqual(
    plain(controller.move({ pointerId: 1, clientX: 14, clientY: 13 })),
    { x: 100, y: 100 }
  );
  assert.equal(
    controller.up({ pointerId: 1, clientX: 14, clientY: 13 }),
    "click"
  );
  assert.deepEqual(events, [["click"]]);
});

test("pointer cancellation rolls an active drag back to its snapped origin", async () => {
  const { createDragController } = await loadLauncher();
  const events = [];
  const controller = createDragController({
    onMove: (point) => events.push(["move", plain(point)]),
    onDrop: (point) => events.push(["drop", plain(point)]),
  });
  controller.down(
    { pointerId: 1, clientX: 10, clientY: 10 },
    { x: 100, y: 100 }
  );
  controller.move({ pointerId: 1, clientX: 40, clientY: 35 });
  assert.equal(controller.cancel(), "rollback");
  assert.deepEqual(events.slice(-2), [
    ["move", { x: 100, y: 100 }],
    ["drop", { x: 100, y: 100 }],
  ]);
});

test("panel opens inward from the snapped edge and remains clamped", async () => {
  const { panelPosition } = await loadLauncher();
  const right = panelPosition(
    { x: 726, y: 300, edge: "right" },
    { width: 800, height: 600 },
    { width: 380, height: 520 },
    62
  );
  assert.equal(right.edge, "right");
  assert.ok(right.left < 726, "right-edge launcher opens to its left");
  assert.ok(right.top >= 12 && right.top <= 68);
});

test("history, Turbo, and PJAX changes share one SPA rebinding seam", async () => {
  const { observeNavigation } = await loadLauncher();
  const listeners = new Map();
  const win = {
    location: { href: "https://github.com/o/r/pull/1/files" },
    document: { documentElement: {} },
    history: {
      pushState(_state, _title, href) {
        win.location.href = href;
      },
      replaceState(_state, _title, href) {
        win.location.href = href;
      },
    },
    addEventListener(name, fn) {
      listeners.set(name, fn);
    },
    removeEventListener(name) {
      listeners.delete(name);
    },
  };
  const changes = [];
  const stop = observeNavigation(win, (next, previous) => changes.push([next, previous]));
  win.history.pushState({}, "", "https://github.com/o/r/pull/2/checks");
  await new Promise((resolve) => queueMicrotask(resolve));
  win.location.href = "https://github.com/o/r/pull/3/files";
  listeners.get("turbo:load")();
  assert.equal(changes.length, 2);
  assert.equal(changes[0][0], "https://github.com/o/r/pull/2/checks");
  assert.equal(changes[1][0], "https://github.com/o/r/pull/3/files");
  stop();
});
