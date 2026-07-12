(function (global) {
  const DEFAULT_MARGIN = 12;
  const DEFAULT_SIZE = 62;

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), Math.max(min, max));
  }

  function clampPoint(point, viewport, size = DEFAULT_SIZE, margin = DEFAULT_MARGIN) {
    return {
      x: clamp(Number(point?.x) || 0, margin, viewport.width - size - margin),
      y: clamp(Number(point?.y) || 0, margin, viewport.height - size - margin),
    };
  }

  function nearestEdge(point, viewport, size = DEFAULT_SIZE, margin = DEFAULT_MARGIN) {
    const p = clampPoint(point, viewport, size, margin);
    const distances = {
      left: p.x - margin,
      right: viewport.width - margin - (p.x + size),
      top: p.y - margin,
      bottom: viewport.height - margin - (p.y + size),
    };
    return Object.entries(distances).sort((a, b) => a[1] - b[1])[0][0];
  }

  function snapPoint(point, viewport, size = DEFAULT_SIZE, margin = DEFAULT_MARGIN) {
    const clamped = clampPoint(point, viewport, size, margin);
    const edge = nearestEdge(clamped, viewport, size, margin);
    if (edge === "left") clamped.x = margin;
    if (edge === "right") clamped.x = viewport.width - size - margin;
    if (edge === "top") clamped.y = margin;
    if (edge === "bottom") clamped.y = viewport.height - size - margin;
    return { ...clamped, edge };
  }

  function dragDistance(start, point) {
    return Math.hypot((point?.x || 0) - (start?.x || 0), (point?.y || 0) - (start?.y || 0));
  }

  function isClick(start, point, threshold = 7) {
    return dragDistance(start, point) < threshold;
  }

  function createDragController({ threshold = 7, onMove = () => {}, onDrop = () => {}, onClick = () => {} } = {}) {
    let active = null;
    return {
      down(event, origin) {
        active = {
          pointerId: event.pointerId,
          start: { x: event.clientX, y: event.clientY },
          origin: { x: origin.x, y: origin.y },
          dragging: false,
        };
      },
      move(event) {
        if (!active || event.pointerId !== active.pointerId) return null;
        const point = {
          x: active.origin.x + event.clientX - active.start.x,
          y: active.origin.y + event.clientY - active.start.y,
        };
        if (
          !active.dragging &&
          isClick(active.start, { x: event.clientX, y: event.clientY }, threshold)
        )
          return active.origin;
        active.dragging = true;
        onMove(point);
        return point;
      },
      up(event) {
        if (!active || event.pointerId !== active.pointerId) return "ignored";
        const point = {
          x: active.origin.x + event.clientX - active.start.x,
          y: active.origin.y + event.clientY - active.start.y,
        };
        const click =
          !active.dragging &&
          isClick(active.start, { x: event.clientX, y: event.clientY }, threshold);
        active = null;
        if (click) {
          onClick();
          return "click";
        }
        onMove(point);
        onDrop(point);
        return "drag";
      },
      cancel() {
        if (active?.dragging) {
          const origin = active.origin;
          active = null;
          onMove(origin);
          onDrop(origin);
          return "rollback";
        }
        active = null;
        return "cancelled";
      },
      active() {
        return !!active;
      },
    };
  }

  function panelPosition(position, viewport, panel = { width: 380, height: 520 }, size = DEFAULT_SIZE, gap = 10) {
    const edge = position?.edge || nearestEdge(position, viewport, size);
    let left;
    let top;
    if (edge === "left") {
      left = position.x + size + gap;
      top = position.y + size / 2 - panel.height / 2;
    } else if (edge === "right") {
      left = position.x - panel.width - gap;
      top = position.y + size / 2 - panel.height / 2;
    } else if (edge === "top") {
      left = position.x + size / 2 - panel.width / 2;
      top = position.y + size + gap;
    } else {
      left = position.x + size / 2 - panel.width / 2;
      top = position.y - panel.height - gap;
    }
    return {
      left: clamp(left, DEFAULT_MARGIN, viewport.width - panel.width - DEFAULT_MARGIN),
      top: clamp(top, DEFAULT_MARGIN, viewport.height - panel.height - DEFAULT_MARGIN),
      edge,
    };
  }

  function observeNavigation(win, onChange) {
    let last = String(win.location.href);
    const notify = () => {
      const next = String(win.location.href);
      if (next === last) return;
      const previous = last;
      last = next;
      onChange(next, previous);
    };
    const originals = {};
    for (const name of ["pushState", "replaceState"]) {
      const original = win.history?.[name];
      if (typeof original !== "function") continue;
      originals[name] = original;
      win.history[name] = function (...args) {
        const result = original.apply(this, args);
        queueMicrotask(notify);
        return result;
      };
    }
    for (const event of ["popstate", "turbo:load", "pjax:end", "turbo:render"])
      win.addEventListener(event, notify);
    const observer =
      typeof global.MutationObserver === "function"
        ? new global.MutationObserver(notify)
        : null;
    observer?.observe(win.document?.documentElement, { childList: true, subtree: true });
    return () => {
      observer?.disconnect();
      for (const event of ["popstate", "turbo:load", "pjax:end", "turbo:render"])
        win.removeEventListener(event, notify);
      for (const [name, original] of Object.entries(originals)) win.history[name] = original;
    };
  }

  global.DiffyLauncher = {
    DEFAULT_MARGIN,
    DEFAULT_SIZE,
    clampPoint,
    nearestEdge,
    snapPoint,
    dragDistance,
    isClick,
    createDragController,
    panelPosition,
    observeNavigation,
  };
})(globalThis);
