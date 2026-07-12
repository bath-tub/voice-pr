(function (global) {
  const State = global.DiffyState;

  function send(runtime, message) {
    return new Promise((resolve) => {
      try {
        runtime.sendMessage(message, (response) =>
          resolve(response || { ok: false, error: "No response from extension background" })
        );
      } catch (error) {
        resolve({ ok: false, error: String(error) });
      }
    });
  }

  function oneLine(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function anchorLabel(anchor) {
    if (!anchor?.file) return "Current PR";
    return `${anchor.file}${anchor.line != null ? `:${anchor.line}` : ""}`;
  }

  function create(options) {
    const {
      launcher,
      badge,
      panel,
      body,
      title,
      back,
      close,
      storage,
      runtime,
      getAnchor,
      onApply,
      onShowPanel,
      onHidePanel,
      renderRuns,
      onRunsAction,
      beforeVoice,
      copyText,
      onActivityChange,
      onTrace = () => {},
    } = options;

    let pr = null;
    let state = State.initialState();
    let activity = null;
    let voice = null;
    let voiceRequestToken = 0;
    let voiceStartingMode = null;
    let applyAutoPaused = false;
    let loadingToken = 0;

    function persist() {
      if (pr) storage.savePr(pr.prUrl, state);
    }

    function dispatch(action, render = true) {
      state = State.reducer(state, action);
      persist();
      if (render && !panel.hidden) renderScreen();
      return state;
    }

    function setHeader(label, canBack = true) {
      title.textContent = label;
      back.hidden = !canBack;
    }

    function el(tag, className, text) {
      const node = global.document.createElement(tag);
      if (className) node.className = className;
      if (text != null) node.textContent = text;
      return node;
    }

    function button(label, action, className = "vp-diffy-button") {
      const node = el("button", className, label);
      node.type = "button";
      if (action) node.dataset.diffyAction = action;
      return node;
    }

    function showStatus(container, text, kind = "") {
      const node = el("div", `vp-diffy-inline-status${kind ? ` ${kind}` : ""}`, text);
      container.appendChild(node);
      return node;
    }

    function renderHome() {
      setHeader("Diffy Command Center", false);
      body.innerHTML = "";
      const intro = el("div", "vp-diffy-intro");
      intro.innerHTML =
        '<span class="vp-diffy-intro-mark" aria-hidden="true">↳</span><div><strong>What are we doing?</strong><span>Everything here stays scoped to this PR.</span></div>';
      body.appendChild(intro);

      const commands = el("div", "vp-diffy-commands");
      const rows = [
        ["apply", "Apply changes", "Speak feedback while you move through the diff.", "⌁"],
        ["ask", "Ask Diffy", "Get a short answer about what is in front of you.", "?"],
        ["followups", "Follow-ups", `${state.followups.filter((item) => !item.resolved).length} open review notes.`, "✓"],
        ["runs", "Runs", "Watch active and completed agent work.", "↗"],
      ];
      for (const [screen, label, detail, icon] of rows) {
        const row = button("", `screen:${screen}`, "vp-diffy-command");
        row.innerHTML = `<span class="vp-diffy-command-icon" aria-hidden="true">${icon}</span><span><strong>${label}</strong><small>${detail}</small></span><span class="vp-diffy-command-arrow" aria-hidden="true">›</span>`;
        commands.appendChild(row);
      }
      for (const [label, detail] of [
        ["Review comments", "Preview — coming soon"],
        ["CI repair", "Preview — coming soon"],
      ]) {
        const row = button("", null, "vp-diffy-command preview");
        row.disabled = true;
        row.innerHTML = `<span class="vp-diffy-command-icon" aria-hidden="true">◇</span><span><strong>${label}</strong><small>${detail}</small></span>`;
        commands.appendChild(row);
      }
      body.appendChild(commands);

      const clearButton = button("Clear this PR session", "clear", "vp-diffy-clear");
      clearButton.title = "Clear Diffy questions, follow-ups, routing choices, and the last open screen for this PR";
      body.appendChild(clearButton);
    }

    function renderAsk() {
      setHeader("Ask Diffy");
      body.innerHTML = "";
      const thread = el("div", "vp-diffy-thread");
      if (!state.qa.items.length)
        showStatus(thread, "Ask about the line or file currently centered in your viewport.");
      for (const item of state.qa.items) {
        const exchange = el("article", "vp-diffy-exchange");
        const question = el("div", "vp-diffy-question");
        question.append(el("small", "", anchorLabel(item.anchor)), el("strong", "", item.question));
        exchange.appendChild(question);
        if (item.status === "asking") showStatus(exchange, "Diffy is thinking…", "thinking");
        else if (item.status === "error") showStatus(exchange, item.error, "error");
        else {
          const answer = el("p", "vp-diffy-answer", item.answer || "No answer returned.");
          exchange.appendChild(answer);
          const actions = el("div", "vp-diffy-answer-actions");
          const explain = button("Explain more", `qa-explain:${item.id}`, "vp-diffy-text-button");
          const copy = button("Copy", `qa-copy:${item.id}`, "vp-diffy-text-button");
          const followup = button("Add as follow-up", `qa-followup:${item.id}`, "vp-diffy-text-button");
          actions.append(explain, copy, followup);
          exchange.appendChild(actions);
        }
        thread.appendChild(exchange);
      }
      body.appendChild(thread);

      const composer = el("form", "vp-diffy-composer");
      composer.dataset.diffyForm = "ask";
      const input = el("textarea", "vp-diffy-input");
      input.name = "question";
      input.rows = 2;
      input.placeholder = "Ask about this PR…";
      input.setAttribute("aria-label", "Question for Diffy");
      const controls = el("div", "vp-diffy-composer-actions");
      const askVoiceActive =
        voice?.mode === "ask" || voiceStartingMode === "ask";
      const mic = button(
        voice?.mode === "ask"
          ? "Stop voice"
          : voiceStartingMode === "ask"
            ? "Cancel voice"
            : "Voice",
        "voice:ask",
        "vp-diffy-voice"
      );
      mic.setAttribute("aria-pressed", String(askVoiceActive));
      const submit = button("Ask", null, "vp-diffy-button");
      submit.type = "submit";
      controls.append(mic, submit);
      composer.append(input, controls);
      body.appendChild(composer);
      requestAnimationFrame(() => input.focus());
    }

    function routeStatus(item) {
      if ((item.status === "created" || item.status === "existing") && item.issueUrl) {
        const link = el(
          "a",
          "vp-diffy-item-status created",
          `Issue #${item.issueNumber || ""} ${item.status === "existing" ? "already exists" : "created"}`
        );
        link.href = item.issueUrl;
        link.target = "_blank";
        link.rel = "noopener";
        return link;
      }
      if (item.status === "copied") return el("span", "vp-diffy-item-status created", "Slack draft copied");
      if (item.status === "error" || item.status === "copy-error")
        return el("span", "vp-diffy-item-status error", item.error || "Routing failed");
      return el("span", "vp-diffy-item-status", item.route === "note" ? "Kept as note" : item.status || "");
    }

    function renderRouting() {
      const batch = el("section", "vp-diffy-routing");
      batch.appendChild(el("h3", "", "Finish review"));
      batch.appendChild(
        el("p", "", "Choose a destination for each open item. Nothing external happens until you confirm.")
      );
      const open = state.followups.filter((item) => !item.resolved);
      for (const item of open) {
        const row = el("div", "vp-diffy-route-row");
        row.appendChild(el("span", "", item.text));
        const select = el("select", "vp-diffy-route-select");
        select.dataset.diffyRouteId = item.id;
        select.setAttribute("aria-label", `Route ${item.text}`);
        for (const [value, label] of [
          ["note", "Keep note"],
          ["issue", "GitHub issue"],
          ["slack", "Copy Slack draft"],
        ]) {
          const option = el("option", "", label);
          option.value = value;
          option.selected = state.routing?.choices?.[item.id] === value;
          select.appendChild(option);
        }
        row.appendChild(select);
        batch.appendChild(row);
      }
      const actions = el("div", "vp-diffy-routing-actions");
      const cancel = button("Cancel", "route-cancel", "vp-diffy-text-button");
      const confirm = button(
        state.routing?.status === "submitting" ? "Routing…" : "Confirm routing",
        "route-confirm"
      );
      confirm.disabled = state.routing?.status === "submitting";
      actions.append(cancel, confirm);
      batch.appendChild(actions);
      return batch;
    }

    function renderFollowups() {
      setHeader("Follow-ups");
      body.innerHTML = "";
      const list = el("div", "vp-diffy-followups");
      if (!state.followups.length)
        showStatus(list, "Capture a note without interrupting the Apply Changes session.");
      for (const item of state.followups) {
        const row = el("article", `vp-diffy-followup${item.resolved ? " resolved" : ""}`);
        const check = el("input");
        check.type = "checkbox";
        check.checked = !!item.resolved;
        check.dataset.diffyToggle = item.id;
        check.setAttribute("aria-label", `Mark resolved: ${item.text}`);
        const content = el("div", "vp-diffy-followup-copy");
        content.append(el("strong", "", item.text), el("small", "", anchorLabel(item.anchor)));
        if (item.transcript && item.transcript !== item.text)
          content.appendChild(el("p", "vp-diffy-transcript", item.transcript));
        content.appendChild(routeStatus(item));
        const remove = button("×", `followup-remove:${item.id}`, "vp-diffy-remove");
        remove.setAttribute("aria-label", `Delete follow-up: ${item.text}`);
        row.append(check, content, remove);
        list.appendChild(row);
      }
      body.appendChild(list);

      const composer = el("form", "vp-diffy-composer");
      composer.dataset.diffyForm = "followup";
      const input = el("textarea", "vp-diffy-input");
      input.name = "followup";
      input.rows = 2;
      input.placeholder = "Add a follow-up…";
      input.setAttribute("aria-label", "New follow-up");
      const controls = el("div", "vp-diffy-composer-actions");
      const followupVoiceActive =
        voice?.mode === "followup" || voiceStartingMode === "followup";
      const mic = button(
        voice?.mode === "followup"
          ? "Stop voice"
          : voiceStartingMode === "followup"
            ? "Cancel voice"
            : "Voice",
        "voice:followup",
        "vp-diffy-voice"
      );
      mic.setAttribute("aria-pressed", String(followupVoiceActive));
      const add = button("Add", null, "vp-diffy-button");
      add.type = "submit";
      controls.append(mic, add);
      composer.append(input, controls);
      body.appendChild(composer);

      const openCount = state.followups.filter((item) => !item.resolved).length;
      const finish = button(`Finish review${openCount ? ` · ${openCount}` : ""}`, "route-open", "vp-diffy-finish");
      finish.disabled = openCount === 0;
      body.appendChild(finish);
      if (state.routing) body.appendChild(renderRouting());
    }

    function renderRunsScreen() {
      setHeader("Runs");
      body.innerHTML = "";
      renderRuns(body);
    }

    function renderScreen() {
      if (!pr) return;
      if (state.screen === "home") renderHome();
      else if (state.screen === "ask") renderAsk();
      else if (state.screen === "followups") renderFollowups();
      else if (state.screen === "runs") renderRunsScreen();
    }

    async function ask(
      question,
      { explain = false, silentActivity = false, anchor: anchorOverride = null } = {}
    ) {
      const text = oneLine(question);
      if (!text || !pr) return;
      const boundPr = pr;
      const bindingToken = loadingToken;
      const priorTurns = state.qa.items
        .filter((item) => item.status === "answered" && item.answer)
        .flatMap((item) => [
          { role: "reviewer", content: item.question },
          { role: "assistant", content: item.answer },
        ])
        .slice(-6);
      const id = State.makeId("qa");
      const threadId = state.qa.threadId || State.makeId("thread");
      const anchor = anchorOverride || getAnchor();
      const startedAt = Date.now();
      dispatch({ type: "QA_ASK", id, threadId, question: text, anchor });
      onTrace("diffy.qa.start", {
        anchored: !!anchor?.file,
        detailLevel: explain ? "expanded" : "concise",
      });
      if (!silentActivity) setActivity("thinking");
      const response = await send(runtime, {
        type: "diffy-qa",
        prUrl: boundPr.prUrl,
        threadId,
        question: text,
        anchor,
        priorTurns,
        explain,
      });
      if (
        bindingToken !== loadingToken ||
        pr?.prUrl !== boundPr.prUrl
      ) {
        onTrace("diffy.qa.stale", {});
        return;
      }
      if (!response.ok || response.json?.error) {
        dispatch({ type: "QA_ERROR", id, error: response.json?.error || response.error || "Unable to ask Diffy" });
        onTrace("diffy.qa.error", { latencyMs: Date.now() - startedAt });
      } else {
        const json = response.json || {};
        dispatch({
          type: "QA_ANSWER",
          id,
          threadId: json.threadId,
          answer: explain ? String(json.answer || "").trim() : oneLine(json.answer),
          anchor: json.anchor,
          metrics: json.metrics,
        });
        onTrace("diffy.qa.done", {
          latencyMs: json.metrics?.qaMs ?? Date.now() - startedAt,
          detailLevel: explain ? "expanded" : "concise",
        });
      }
      if (!silentActivity) setActivity(null);
    }

    async function blobToB64(blob) {
      return new Promise((resolve) => {
        const reader = new FileReader();
        reader.onloadend = () => resolve(String(reader.result || "").split(",")[1] || "");
        reader.readAsDataURL(blob);
      });
    }

    function transcriptText(json) {
      if (typeof json?.text === "string") return json.text;
      if (typeof json?.transcript === "string") return json.transcript;
      if (Array.isArray(json?.segments))
        return json.segments.map((segment) => segment.text || segment.transcript || "").join(" ");
      return "";
    }

    async function stopVoice({ onReleased = null, preserveActivity = false } = {}) {
      const current = voice;
      if (!current) return;
      voice = null;
      if (current.recorder.state !== "inactive") current.recorder.stop();
      current.stream.getTracks().forEach((track) => track.stop());
      const blob = await current.done;
      renderScreen();
      if (current.resumeApply) applyAutoPaused = true;
      onReleased?.(current);
      if (!blob?.size) return;
      const audioB64 = await blobToB64(blob);
      if (!preserveActivity) setActivity("thinking");
      const response = await send(runtime, {
        type: "diffy-transcribe",
        audioB64,
        ext: /mp4/.test(blob.type) ? "mp4" : "webm",
        prUrl: current.pr.prUrl,
        sessionId: State.makeId("voice"),
        anchor: current.anchor,
      });
      if (
        current.bindingToken !== loadingToken ||
        pr?.prUrl !== current.pr.prUrl
      ) {
        onTrace("diffy.voice.stale", {});
        return;
      }
      if (!preserveActivity) setActivity(null);
      const text = oneLine(transcriptText(response.json));
      if (!response.ok || !text) {
        const host = el("div", "vp-diffy-voice-error", response.error || response.json?.error || "No speech detected");
        body.appendChild(host);
        return;
      }
      if (current.mode === "ask")
        return ask(text, {
          silentActivity: preserveActivity,
          anchor: current.anchor,
        });
      dispatch({
        type: "FOLLOWUP_ADD",
        id: State.makeId("followup"),
        text,
        transcript: text,
        anchor: current.anchor,
      });
      onTrace("diffy.followup.capture", {
        source: "voice",
        anchored: !!current.anchor?.file,
      });
    }

    function cancelPendingVoice() {
      if (!voiceStartingMode) return false;
      voiceRequestToken++;
      voiceStartingMode = null;
      setActivity(null);
      renderScreen();
      return true;
    }

    async function toggleVoice(mode) {
      if (voice) return stopVoice();
      if (cancelPendingVoice()) return;
      const requestToken = ++voiceRequestToken;
      voiceStartingMode = mode;
      renderScreen();
      const requestedPr = pr;
      const bindingToken = loadingToken;
      const beforeResult = beforeVoice?.(mode);
      const resumeApply =
        beforeResult && typeof beforeResult.then === "function"
          ? await beforeResult
          : beforeResult;
      if (
        requestToken !== voiceRequestToken ||
        bindingToken !== loadingToken ||
        !requestedPr ||
        pr?.prUrl !== requestedPr.prUrl
      )
        return;
      if (resumeApply) applyAutoPaused = true;
      setActivity("thinking");
      let stream = null;
      let recorder = null;
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (
          requestToken !== voiceRequestToken ||
          bindingToken !== loadingToken ||
          !requestedPr ||
          pr?.prUrl !== requestedPr.prUrl
        ) {
          stream.getTracks().forEach((track) => track.stop());
          onTrace("diffy.voice.stale", {});
          return;
        }
        const chunks = [];
        recorder = new MediaRecorder(stream);
        let resolveDone;
        const done = new Promise((resolve) => (resolveDone = resolve));
        recorder.ondataavailable = (event) => event.data.size && chunks.push(event.data);
        recorder.onstop = () =>
          resolveDone(new Blob(chunks, { type: chunks[0]?.type || "audio/webm" }));
        const nextVoice = {
          mode,
          recorder,
          stream,
          done,
          anchor: getAnchor(),
          pr: requestedPr,
          bindingToken,
          resumeApply: applyAutoPaused,
        };
        recorder.start();
        voice = nextVoice;
        voiceStartingMode = null;
        setActivity("listening");
        renderScreen();
      } catch (error) {
        try {
          if (recorder?.state !== "inactive") recorder.stop();
        } catch {}
        stream?.getTracks().forEach((track) => track.stop());
        if (
          requestToken !== voiceRequestToken ||
          bindingToken !== loadingToken ||
          pr?.prUrl !== requestedPr?.prUrl
        )
          return;
        voiceStartingMode = null;
        setActivity(null);
        renderScreen();
        showStatus(body, `Microphone unavailable: ${error.message || error}`, "error");
      }
    }

    function cancelVoice() {
      voiceRequestToken++;
      voiceStartingMode = null;
      const current = voice;
      voice = null;
      if (current) {
        try {
          if (current.recorder.state !== "inactive") current.recorder.stop();
        } catch {}
        current.stream.getTracks().forEach((track) => track.stop());
      }
      applyAutoPaused = false;
      setActivity(null);
    }

    async function confirmRouting() {
      const boundPr = pr;
      const bindingToken = loadingToken;
      const choices = state.routing?.choices || {};
      const issueItems = state.followups
        .filter((item) => choices[item.id] === "issue" && !item.resolved)
        .map(({ id, text, transcript, anchor }) => ({ id, text, transcript, anchor }));
      const slackItems = state.followups.filter(
        (item) => choices[item.id] === "slack" && !item.resolved
      );
      onTrace("diffy.routing.confirm", {
        issues: issueItems.length,
        slackDrafts: slackItems.length,
        notes: Object.values(choices).filter((route) => route === "note").length,
      });
      dispatch({ type: "ROUTING_SUBMIT" });

      let results = [];
      if (issueItems.length) {
        const response = await send(runtime, {
          type: "diffy-followup-issues",
          prUrl: boundPr.prUrl,
          items: issueItems,
        });
        if (response.ok && Array.isArray(response.json?.results)) results = response.json.results;
        else
          results = issueItems.map((item) => ({
            id: item.id,
            status: "error",
            error: response.json?.error || response.error || "Issue creation failed",
          }));
      }
      if (
        bindingToken !== loadingToken ||
        pr?.prUrl !== boundPr.prUrl
      ) {
        onTrace("diffy.routing.stale", {});
        return;
      }

      let slackCopied = true;
      let slackError = null;
      if (slackItems.length) {
        const draft = slackItems
          .map((item) => State.slackDraft(item, boundPr))
          .join("\n\n");
        slackCopied = await copyText(draft);
        if (!slackCopied) slackError = "Could not copy Slack draft";
      }
      if (
        bindingToken !== loadingToken ||
        pr?.prUrl !== boundPr.prUrl
      ) {
        onTrace("diffy.routing.stale", {});
        return;
      }
      dispatch({ type: "ROUTING_RESULTS", results, slackCopied, slackError });
      onTrace("diffy.session.finish", {
        issuesCreated: results.filter((result) => result.status === "created").length,
        issuesExisting: results.filter((result) => result.status === "existing").length,
        failures:
          results.filter((result) => result.status === "error").length +
          (slackError ? 1 : 0),
      });
    }

    body.addEventListener("submit", (event) => {
      event.preventDefault();
      const form = event.target;
      if (form.dataset.diffyForm === "ask") {
        const value = form.elements.question.value;
        form.elements.question.value = "";
        ask(value);
      } else if (form.dataset.diffyForm === "followup") {
        const text = oneLine(form.elements.followup.value);
        if (!text) return;
        const anchor = getAnchor();
        dispatch({
          type: "FOLLOWUP_ADD",
          id: State.makeId("followup"),
          text,
          transcript: text,
          anchor,
        });
        onTrace("diffy.followup.capture", {
          source: "text",
          anchored: !!anchor?.file,
        });
      }
    });

    body.addEventListener("change", (event) => {
      if (event.target.dataset.diffyToggle)
        dispatch({ type: "FOLLOWUP_TOGGLE", id: event.target.dataset.diffyToggle });
      if (event.target.dataset.diffyRouteId)
        dispatch({
          type: "ROUTING_SET",
          id: event.target.dataset.diffyRouteId,
          route: event.target.value,
        });
    });

    body.addEventListener("click", async (event) => {
      const target = event.target.closest("[data-diffy-action], [data-vp-action]");
      if (!target) return;
      const action = target.dataset.diffyAction;
      if (!action && target.dataset.vpAction) return onRunsAction(target);
      if (action?.startsWith("screen:")) return navigate(action.slice(7));
      if (action === "clear") {
        onTrace("diffy.session.clear", {});
        await storage.clearPr(pr.prUrl);
        state = State.initialState();
        return renderScreen();
      }
      if (action?.startsWith("voice:")) return toggleVoice(action.slice(6));
      if (action?.startsWith("qa-copy:")) {
        const item = state.qa.items.find((entry) => entry.id === action.slice(8));
        if (item?.answer) await copyText(item.answer);
        onTrace("diffy.qa.usefulness", { action: "copy" });
        target.textContent = "Copied";
        return;
      }
      if (action?.startsWith("qa-followup:")) {
        const item = state.qa.items.find((entry) => entry.id === action.slice(12));
        if (item?.answer)
          dispatch({
            type: "FOLLOWUP_ADD",
            id: State.makeId("followup"),
            text: item.answer,
            transcript: item.answer,
            anchor: item.answerAnchor || item.anchor,
          });
        onTrace("diffy.qa.usefulness", { action: "followup" });
        return;
      }
      if (action?.startsWith("qa-explain:")) {
        const item = state.qa.items.find((entry) => entry.id === action.slice(11));
        onTrace("diffy.qa.usefulness", { action: "explain" });
        return ask(`Explain more about: ${item?.question || "your previous answer"}`, {
          explain: true,
          anchor: item?.answerAnchor || item?.anchor || null,
        });
      }
      if (action?.startsWith("followup-remove:"))
        return dispatch({ type: "FOLLOWUP_REMOVE", id: action.slice(16) });
      if (action === "route-open") {
        onTrace("diffy.routing.open", {
          items: state.followups.filter((item) => !item.resolved).length,
        });
        return dispatch({ type: "ROUTING_OPEN" });
      }
      if (action === "route-cancel") return dispatch({ type: "ROUTING_CLOSE" });
      if (action === "route-confirm") return confirmRouting();
    });

    async function bindPr(nextPr) {
      const token = ++loadingToken;
      if (pr) {
        if (state.qa.items.some((item) => item.status === "asking"))
          dispatch(
            {
              type: "QA_CANCEL_PENDING",
              error: "Question interrupted by PR navigation",
            },
            false
          );
        if (state.routing?.status === "submitting")
          dispatch({ type: "ROUTING_CLOSE" }, false);
      }
      cancelVoice();
      pr = nextPr;
      const loaded = await storage.loadPr(pr.prUrl);
      if (token !== loadingToken) return;
      state = State.normalizeState(loaded);
      if (!panel.hidden && state.screen !== "apply") renderScreen();
    }

    function unbindPr() {
      loadingToken++;
      if (pr) {
        if (state.qa.items.some((item) => item.status === "asking"))
          dispatch(
            {
              type: "QA_CANCEL_PENDING",
              error: "Question interrupted by PR navigation",
            },
            false
          );
        if (state.routing?.status === "submitting")
          dispatch({ type: "ROUTING_CLOSE" }, false);
      }
      cancelVoice();
      pr = null;
    }

    function navigate(screen) {
      onTrace("diffy.mode.enter", { screen });
      if (screen === "apply") {
        dispatch({ type: "NAVIGATE", screen }, false);
        panel.hidden = true;
        if (voice) {
          stopVoice({
            onReleased: (released) => {
              const resumeRecording =
                released.resumeApply || applyAutoPaused;
              applyAutoPaused = false;
              onApply({
                resume: true,
                explicit: true,
                resumeRecording,
              });
            },
            preserveActivity: true,
          });
          return;
        }
        if (voiceStartingMode) cancelPendingVoice();
        const resumeRecording = applyAutoPaused;
        applyAutoPaused = false;
        onApply({ resume: true, explicit: true, resumeRecording });
        return;
      }
      dispatch({ type: "NAVIGATE", screen }, false);
      onShowPanel();
      panel.hidden = false;
      renderScreen();
    }

    function open() {
      onTrace("diffy.open", { screen: state.screen });
      if (state.screen === "apply")
        return onApply({ resume: true, explicit: false });
      onShowPanel();
      panel.hidden = false;
      renderScreen();
      requestAnimationFrame(() => {
        const focusable = body.querySelector("button:not(:disabled), textarea, input, select");
        focusable?.focus();
      });
    }

    function collapse() {
      onTrace("diffy.collapse", {
        screen: state.screen,
        active: activity || null,
      });
      panel.hidden = true;
      onHidePanel();
      launcher.focus();
    }

    function setActivity(next) {
      activity = next;
      badge.hidden = !next;
      badge.textContent = next === "listening" ? "●" : next === "thinking" ? "…" : "";
      badge.className = `vp-diffy-badge${next ? ` ${next}` : ""}`;
      launcher.setAttribute(
        "aria-label",
        next ? `Open Diffy Command Center — ${next}` : "Open Diffy Command Center"
      );
      onActivityChange?.(next);
    }

    back.addEventListener("click", () => navigate("home"));
    close.addEventListener("click", collapse);

    return {
      bindPr,
      unbindPr,
      open,
      collapse,
      navigate,
      cancelVoice,
      markScreen(screen) {
        dispatch({ type: "NAVIGATE", screen }, false);
      },
      setActivity,
      refresh() {
        if (!panel.hidden && state.screen !== "apply") renderScreen();
      },
      state() {
        return state;
      },
      isOpen() {
        return !panel.hidden;
      },
      activity() {
        return activity;
      },
      currentPr() {
        return pr;
      },
    };
  }

  global.DiffyCommandCenter = { create, oneLine, anchorLabel };
})(globalThis);
