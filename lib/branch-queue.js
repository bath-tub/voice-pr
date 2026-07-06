export function createBranchQueue() {
  const tails = new Map();
  const depths = new Map();

  async function run(key, task, hooks = {}) {
    const queueKey = normalizeKey(key);
    if (typeof task !== "function") throw new Error("branch queue task must be a function");

    const previous = tails.get(queueKey) || Promise.resolve();
    const depth = depths.get(queueKey) || 0;
    const queued = depth > 0;

    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const tail = previous.catch(() => {}).then(() => gate);

    tails.set(queueKey, tail);
    depths.set(queueKey, depth + 1);

    if (queued) hooks.onQueued?.({ key: queueKey, position: depth + 1 });

    try {
      await previous.catch(() => {});
      hooks.onStarted?.({ key: queueKey });
      return await task();
    } finally {
      release();
      const nextDepth = (depths.get(queueKey) || 1) - 1;
      if (nextDepth <= 0) depths.delete(queueKey);
      else depths.set(queueKey, nextDepth);
      if (tails.get(queueKey) === tail && nextDepth <= 0) tails.delete(queueKey);
    }
  }

  function pending(key) {
    return depths.get(normalizeKey(key)) || 0;
  }

  return { run, pending };
}

export function branchQueueKey(pr) {
  return normalizeKey(`${pr.owner}/${pr.repo}:${pr.headRefName}`);
}

function normalizeKey(key) {
  const normalized = String(key || "").trim();
  if (!normalized) throw new Error("branch queue key is required");
  return normalized;
}

export const branchDispatchQueue = createBranchQueue();
