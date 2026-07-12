(function (global) {
  const SCREENS = new Set(["home", "apply", "ask", "followups", "runs"]);

  function parsePrUrl(value) {
    let url;
    try {
      url = new URL(String(value || ""), "https://github.com");
    } catch {
      return null;
    }
    if (url.hostname !== "github.com") return null;
    const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/pull\/(\d+)(?:\/|$)/);
    if (!match) return null;
    const [, owner, repo, number] = match;
    return {
      owner,
      repo,
      number,
      prUrl: `${url.origin}/${owner}/${repo}/pull/${number}`,
      id: `${owner}/${repo}#${number}`,
    };
  }

  function prStateKey(value) {
    const pr = typeof value === "string" ? parsePrUrl(value) : value;
    return pr ? `diffy:pr:${pr.id}` : null;
  }

  function initialState() {
    return {
      version: 1,
      screen: "home",
      qa: { threadId: null, items: [] },
      followups: [],
      routing: null,
    };
  }

  function normalizeState(value) {
    const base = initialState();
    if (!value || typeof value !== "object") return base;
    return {
      ...base,
      ...value,
      screen: SCREENS.has(value.screen) ? value.screen : "home",
      qa: {
        threadId: value.qa?.threadId || null,
        items: Array.isArray(value.qa?.items) ? value.qa.items.slice(-24) : [],
      },
      followups: Array.isArray(value.followups) ? value.followups : [],
      routing: value.routing && typeof value.routing === "object" ? value.routing : null,
    };
  }

  function makeId(prefix = "item", now = Date.now(), random = Math.random()) {
    return `${prefix}-${Number(now).toString(36)}-${Math.floor(random * 0xffffff)
      .toString(36)
      .padStart(4, "0")}`;
  }

  function reducer(current, action = {}) {
    const state = normalizeState(current);
    switch (action.type) {
      case "NAVIGATE":
        return SCREENS.has(action.screen) ? { ...state, screen: action.screen } : state;
      case "QA_ASK": {
        const item = {
          id: action.id,
          question: String(action.question || "").trim(),
          anchor: action.anchor || null,
          askedAt: action.at || Date.now(),
          status: "asking",
        };
        return {
          ...state,
          qa: {
            threadId: action.threadId || state.qa.threadId,
            items: [...state.qa.items, item].slice(-24),
          },
        };
      }
      case "QA_ANSWER":
        return {
          ...state,
          qa: {
            threadId: action.threadId || state.qa.threadId,
            items: state.qa.items.map((item) =>
              item.id === action.id
                ? {
                    ...item,
                    answer: String(action.answer || "").trim(),
                    answerAnchor: action.anchor || null,
                    metrics: action.metrics || null,
                    status: "answered",
                  }
                : item
            ),
          },
        };
      case "QA_ERROR":
        return {
          ...state,
          qa: {
            ...state.qa,
            items: state.qa.items.map((item) =>
              item.id === action.id ? { ...item, status: "error", error: String(action.error || "Unable to ask Diffy") } : item
            ),
          },
        };
      case "QA_CANCEL_PENDING":
        return {
          ...state,
          qa: {
            ...state.qa,
            items: state.qa.items.map((item) =>
              item.status === "asking"
                ? {
                    ...item,
                    status: "error",
                    error: String(
                      action.error || "Question interrupted by PR navigation"
                    ),
                  }
                : item
            ),
          },
        };
      case "FOLLOWUP_ADD": {
        const item = {
          id: action.id,
          text: String(action.text || "").trim(),
          transcript: String(action.transcript || action.text || "").trim(),
          anchor: action.anchor || null,
          createdAt: action.at || Date.now(),
          resolved: false,
          route: "note",
          status: "note",
          issueUrl: null,
          issueNumber: null,
          error: null,
        };
        return item.text ? { ...state, followups: [...state.followups, item] } : state;
      }
      case "FOLLOWUP_TOGGLE":
        return {
          ...state,
          followups: state.followups.map((item) =>
            item.id === action.id ? { ...item, resolved: !item.resolved } : item
          ),
        };
      case "FOLLOWUP_REMOVE":
        return { ...state, followups: state.followups.filter((item) => item.id !== action.id) };
      case "ROUTING_OPEN":
        return {
          ...state,
          routing: {
            choices: Object.fromEntries(
              state.followups.filter((item) => !item.resolved).map((item) => [item.id, item.route || "note"])
            ),
            status: "editing",
          },
        };
      case "ROUTING_SET":
        return state.routing
          ? {
              ...state,
              routing: {
                ...state.routing,
                choices: { ...state.routing.choices, [action.id]: action.route },
              },
            }
          : state;
      case "ROUTING_SUBMIT":
        return state.routing ? { ...state, routing: { ...state.routing, status: "submitting" } } : state;
      case "ROUTING_RESULTS": {
        const byId = new Map(
          (action.results || []).map((result) => [
            result.id || result.clientItemId,
            result,
          ])
        );
        const choices = state.routing?.choices || {};
        return {
          ...state,
          followups: state.followups.map((item) => {
            const result = byId.get(item.id);
            const route = choices[item.id] || item.route || "note";
            if (route === "note") return { ...item, route, status: "note", error: null };
            if (route === "slack")
              return { ...item, route, status: action.slackCopied ? "copied" : "copy-error", error: action.slackError || null };
            if (!result) return { ...item, route, status: "error", error: "No issue result returned" };
            return {
              ...item,
              route,
              status: result.status || (result.issueUrl ? "created" : "error"),
              issueUrl: result.issueUrl || null,
              issueNumber: result.issueNumber || null,
              error: result.error || null,
            };
          }),
          routing: { ...(state.routing || {}), status: "done" },
        };
      }
      case "ROUTING_CLOSE":
        return { ...state, routing: null };
      case "CLEAR_SESSION":
        return initialState();
      default:
        return state;
    }
  }

  function slackDraft(item, pr) {
    const anchor = item.anchor?.file
      ? ` (${item.anchor.file}${item.anchor.line != null ? `:${item.anchor.line}` : ""})`
      : "";
    return `[${pr?.owner || ""}/${pr?.repo || ""}#${pr?.number || ""}] ${String(item.text || "").trim()}${anchor}`;
  }

  global.DiffyState = {
    SCREENS,
    parsePrUrl,
    prStateKey,
    initialState,
    normalizeState,
    makeId,
    reducer,
    slackDraft,
  };
})(globalThis);
