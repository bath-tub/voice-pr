(function (global) {
  const POSITION_KEY = "diffy:launcher-position";

  function call(area, method, value) {
    return new Promise((resolve) => {
      try {
        area[method](value, (result) => resolve(result));
      } catch {
        resolve(undefined);
      }
    });
  }

  function createStorage(area = global.chrome?.storage?.local) {
    return {
      async get(key, fallback = null) {
        if (!area || !key) return fallback;
        const result = await call(area, "get", key);
        return result?.[key] ?? fallback;
      },
      async set(key, value) {
        if (!area || !key) return;
        await call(area, "set", { [key]: value });
      },
      async remove(key) {
        if (!area || !key) return;
        await call(area, "remove", key);
      },
      loadPosition() {
        return this.get(POSITION_KEY, null);
      },
      savePosition(position) {
        return this.set(POSITION_KEY, position);
      },
      loadPr(prUrl) {
        const key = global.DiffyState?.prStateKey(prUrl);
        return this.get(key, global.DiffyState?.initialState?.() || null);
      },
      savePr(prUrl, state) {
        return this.set(global.DiffyState?.prStateKey(prUrl), state);
      },
      clearPr(prUrl) {
        return this.remove(global.DiffyState?.prStateKey(prUrl));
      },
    };
  }

  global.DiffyStorage = { POSITION_KEY, createStorage };
})(globalThis);
