// Agent panel webview. Renders the state object posted by the extension; holds no state of its own
// except the draft in the input box.
(function () {
  const vscode = acquireVsCodeApi();
  const $ = (id) => document.getElementById(id);
  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };
  const button = (label, cls, onClick, title) => {
    const b = el("button", cls, label);
    if (title) b.title = title;
    b.addEventListener("click", onClick);
    return b;
  };
  const post = (type, extra) => vscode.postMessage({ type, ...extra });

  const input = $("input");
  const send = () => {
    const text = input.value.trim();
    if (!text) return;
    post("send", { text });
    input.value = "";
  };
  $("send").addEventListener("click", send);
  $("stop").addEventListener("click", () => post("stop"));
  $("new").addEventListener("click", () => post("new"));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  function renderItem(t) {
    if (t.kind === "user") {
      const n = el("div", "msg user");
      if (t.inline) n.appendChild(el("div", "tag", "Inline edit · " + t.inline));
      n.appendChild(el("div", "text", t.text));
      return n;
    }
    if (t.kind === "assistant") return el("div", "msg assistant", t.text);
    if (t.kind === "notice") return el("div", "notice " + t.level, t.text);
    if (t.kind === "context") {
      const d = el("details", "context");
      d.open = true;
      d.appendChild(el("summary", "", `Context selected: ${t.files.length} file(s), ${t.used.toLocaleString()} of ${t.budget.toLocaleString()} chars budget (${t.candidates} candidates ranked)`));
      for (const f of t.files) {
        const row = el("div", "ctx");
        row.appendChild(el("span", "path", `${f.path}:${f.lines.join(", ")}`));
        row.appendChild(el("span", "why", f.reason + ` · ${f.chars.toLocaleString()} chars`));
        d.appendChild(row);
      }
      for (const note of t.notes) d.appendChild(el("div", "ctxnote", note));
      if (!t.files.length) d.appendChild(el("div", "ctxnote", "Nothing matched; the agent will search with its tools."));
      return d;
    }
    if (t.kind === "tool") {
      const d = el("details", "tool " + t.state.replace(/ /g, "-"));
      d.open = t.tool === "search_workspace" && !!t.result;
      d.appendChild(el("summary", "", `${t.tool}${t.via ? " (deferred, via " + t.via + ")" : ""} · ${t.state}  ${t.args}`));
      if (t.result) d.appendChild(el("pre", "", t.result));
      return d;
    }
    return el("div");
  }

  function renderProposal(p) {
    const box = el("div", "proposal");
    const head = el("div", "phead");
    head.appendChild(el("span", "path", p.path));
    head.appendChild(button("Open diff", "link", () => post("openDiff", { proposal: p.id })));
    head.appendChild(button("Accept all", "small", () => post("all", { proposal: p.id, accept: true })));
    head.appendChild(button("Reject all", "small secondary", () => post("all", { proposal: p.id, accept: false })));
    box.appendChild(head);
    if (p.summary) box.appendChild(el("div", "summary", p.summary));
    p.hunks.forEach((h, i) => {
      const hb = el("div", "hunk" + (h.decision === true ? " accepted" : h.decision === false ? " rejected" : ""));
      const bar = el("div", "hbar");
      bar.appendChild(el("span", "", `Hunk ${i + 1}/${p.hunks.length} · line ${h.line}` + (h.decision === true ? " · accepted" : h.decision === false ? " · rejected" : "")));
      bar.appendChild(button("Accept", "small", () => post("hunk", { proposal: p.id, hunk: h.id, accept: true })));
      bar.appendChild(button("Reject", "small secondary", () => post("hunk", { proposal: p.id, hunk: h.id, accept: false })));
      hb.appendChild(bar);
      const pre = el("pre", "diff");
      for (const l of h.oldLines) pre.appendChild(el("div", "del", "- " + l));
      for (const l of h.newLines) pre.appendChild(el("div", "add", "+ " + l));
      hb.appendChild(pre);
      box.appendChild(hb);
    });
    return box;
  }

  window.addEventListener("message", (ev) => {
    if (ev.data?.type === "demoType") {
      const text = String(ev.data.text ?? "");
      let i = 0;
      input.focus();
      const timer = setInterval(() => {
        input.value = text.slice(0, ++i);
        input.scrollTop = input.scrollHeight;
        if (i >= text.length) {
          clearInterval(timer);
          setTimeout(send, 500);
        }
      }, 15);
      return;
    }
    if (ev.data?.type !== "state") return;
    const s = ev.data.state;
    const log = $("log");
    const pinned = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    const open = new Map([...log.querySelectorAll("details")].map((d, i) => [i, d.open]));
    log.replaceChildren(...s.transcript.map(renderItem));
    [...log.querySelectorAll("details")].forEach((d, i) => {
      if (open.has(i) && i < open.size - 1) d.open = open.get(i);
    });
    if (pinned) log.scrollTop = log.scrollHeight;

    $("status").textContent = (s.running ? "● " : "") + s.status;
    $("status").className = s.running ? "running" : "";
    const sess = $("session");
    sess.replaceChildren();
    if (s.session) sess.appendChild(button(`TrueForge session ${s.session.id.slice(-8)} · ${s.session.agent}`, "link", () => post("openSession"), s.session.url));

    const review = $("review");
    review.replaceChildren();
    if (s.proposals.length) {
      review.appendChild(el("div", "rtitle", "Review proposed changes (nothing is written until you apply)"));
      s.proposals.forEach((p) => review.appendChild(renderProposal(p)));
    }

    const actions = $("actions");
    actions.replaceChildren();
    if (s.staged.length) {
      const line = el("div", "staged", "Accepted, not yet on disk: ");
      s.staged.forEach((f) => line.appendChild(button(`${f.path} (${f.hunks})`, "link", () => post("openStaged", { path: f.path }))));
      actions.appendChild(line);
      const apply = button("Apply accepted edits", "", () => post("apply"));
      apply.disabled = !s.canApply;
      apply.title = s.canApply ? "Write the accepted hunks to the files" : "Available when the run has finished successfully";
      actions.appendChild(apply);
      const discard = button("Discard", "secondary", () => post("discard"));
      discard.disabled = s.running;
      actions.appendChild(discard);
    }
    if (s.canUndo) actions.appendChild(button("Undo last apply", "secondary", () => post("undo")));

    $("send").disabled = s.running;
    $("stop").disabled = !s.running;
    $("new").disabled = s.running;
  });
  post("ready");
})();
