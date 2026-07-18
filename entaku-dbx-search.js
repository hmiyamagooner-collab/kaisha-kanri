/* 円卓：Dropbox検索（必ず社長承認が必要。社長本人は即検索可） */
(function () {
  const LS = "gp_entaku_dbx_search_v1";
  const DBX_FILE = "/GoonerPortal/_portal/dbx-search-approvals.json";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function toast(msg) {
    try {
      window.Treasury?.toast?.(msg);
    } catch (e) {}
    if (!window.Treasury?.toast) try { alert(msg); } catch (e2) {}
  }
  function isPresident() {
    const m = window.GoonerSB?.me?.();
    const u = window.PortalAuth?.getUser?.();
    return (m && m.role === "社長") || (u && u.role === "社長");
  }
  function who() {
    const u = window.PortalAuth?.getUser?.() || {};
    const m = window.GoonerSB?.me?.() || {};
    return { name: u.name || m.name || "利用者", email: u.email || m.email || "", id: m.id || u.email || "" };
  }
  function loadLocal() {
    try {
      return JSON.parse(localStorage.getItem(LS) || '{"requests":[]}');
    } catch (e) {
      return { requests: [] };
    }
  }
  function saveLocal(data) {
    localStorage.setItem(LS, JSON.stringify(data));
  }
  function uid() {
    return "dbxreq-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }
  function base64ToUtf8(b64) {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }

  async function pullRemote() {
    if (!window.dbxDownloadBase64) return loadLocal();
    try {
      const j = await window.dbxDownloadBase64(DBX_FILE);
      const parsed = JSON.parse(base64ToUtf8(j.base64 || ""));
      if (parsed && Array.isArray(parsed.requests)) {
        const local = loadLocal();
        const map = {};
        local.requests.concat(parsed.requests).forEach(function (r) {
          if (!r || !r.id) return;
          const prev = map[r.id];
          if (!prev || String(r.updatedAt || r.createdAt || "") > String(prev.updatedAt || prev.createdAt || "")) {
            map[r.id] = r;
          }
        });
        const merged = { requests: Object.keys(map).map(function (k) { return map[k]; }) };
        merged.requests.sort(function (a, b) {
          return String(b.createdAt || "").localeCompare(String(a.createdAt || ""));
        });
        saveLocal(merged);
        return merged;
      }
    } catch (e) {
      /* ファイル未作成は無視 */
    }
    return loadLocal();
  }

  async function pushRemote(data) {
    if (!window.dbxUploadBase64) return;
    try {
      await window.dbxUploadBase64(DBX_FILE, utf8ToBase64(JSON.stringify(data, null, 2)), { mode: "overwrite" });
    } catch (e) {
      console.warn("[entaku-dbx] sync push failed", e);
    }
  }

  function ensurePanel() {
    let panel = document.getElementById("entakuDbxPanel");
    if (panel) return panel;
    const form = document.getElementById("entakuForm");
    if (!form || !form.parentNode) return null;
    panel = document.createElement("div");
    panel.id = "entakuDbxPanel";
    panel.hidden = true;
    form.parentNode.insertBefore(panel, form);
    return panel;
  }

  function postToEntaku(text) {
    try {
      window.dispatchEvent(
        new CustomEvent("entaku-system-message", { detail: { text: text, agent: "secretary" } })
      );
    } catch (e) {
      toast(String(text).slice(0, 100));
    }
  }

  async function runSearch(query) {
    if (!window.dbxSearch) throw new Error("Dropbox検索API未接続");
    const j = await window.dbxSearch(query);
    const matches = j.matches || [];
    let text =
      "【Dropbox検索結果】「" + query + "」\n" +
      (matches.length
        ? matches
            .slice(0, 20)
            .map(function (m, i) {
              return (i + 1) + ". " + (m.name || "") + "\n   " + (m.path || "");
            })
            .join("\n")
        : "該当ファイルはありませんでした。");
    postToEntaku(text);
    return matches;
  }

  function pendingCount(data) {
    return (data.requests || []).filter(function (r) { return r.status === "pending"; }).length;
  }

  function syncBtn(data) {
    const btn = document.getElementById("entakuDbxSearchBtn");
    if (!btn) return;
    const n = pendingCount(data || loadLocal());
    btn.classList.toggle("has-pending", isPresident() && n > 0);
    btn.title = isPresident()
      ? n > 0
        ? "Dropbox検索（承認待ち " + n + "件）"
        : "Dropbox内を検索"
      : "Dropbox内を検索（要・社長承認）";
  }

  function renderPanel(data) {
    const panel = ensurePanel();
    if (!panel) return;
    data = data || loadLocal();
    const prez = isPresident();
    const pending = (data.requests || []).filter(function (r) { return r.status === "pending"; });

    panel.innerHTML =
      "<div><b>Dropbox検索</b>" +
      (prez ? "（社長：即検索可／承認もここで）" : "（検索には必ず社長の承認が必要です）") +
      "</div>" +
      '<div class="edbx-row">' +
      '<input id="edbxQ" placeholder="ファイル名・キーワード" maxlength="200">' +
      '<button type="button" id="edbxSubmit">' +
      (prez ? "検索する" : "承認を依頼") +
      "</button>" +
      '<button type="button" id="edbxClose">閉じる</button>' +
      "</div>" +
      (prez
        ? ""
        : '<p class="edbx-warn">社員からの検索は社長が承認するまで実行されません。承認後に結果が円卓へ表示されます。</p>') +
      (prez && pending.length
        ? '<div class="edbx-list"><b>承認待ち</b>' +
          pending
            .map(function (r) {
              return (
                '<div class="edbx-item"><span>' +
                esc(r.byName || "社員") +
                "：「" +
                esc(r.query) +
                "」</span>" +
                '<span><button type="button" data-approve="' +
                esc(r.id) +
                '">承認して検索</button> ' +
                '<button type="button" data-reject="' +
                esc(r.id) +
                '">却下</button></span></div>'
              );
            })
            .join("") +
          "</div>"
        : "") +
      '<div class="edbx-list" id="edbxRecent"></div>';

    panel.querySelector("#edbxClose")?.addEventListener("click", function () {
      panel.hidden = true;
    });
    panel.querySelector("#edbxSubmit")?.addEventListener("click", async function () {
      const q = (panel.querySelector("#edbxQ")?.value || "").trim();
      if (!q) {
        toast("検索語を入力してください");
        return;
      }
      if (prez) {
        try {
          toast("検索中…");
          await runSearch(q);
        } catch (e) {
          toast("検索失敗: " + (e.message || e));
        }
        return;
      }
      const w = who();
      const req = {
        id: uid(),
        query: q,
        status: "pending",
        byName: w.name,
        byEmail: w.email,
        byId: w.id,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const cur = await pullRemote();
      cur.requests.unshift(req);
      cur.requests = cur.requests.slice(0, 80);
      saveLocal(cur);
      await pushRemote(cur);
      syncBtn(cur);
      postToEntaku("Dropbox検索「" + q + "」の承認を社長へ依頼しました。承認されるまで検索は実行されません。");
      toast("社長へ承認依頼を送りました");
      renderPanel(cur);
    });

    panel.querySelectorAll("[data-approve]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        if (!isPresident()) return;
        const id = btn.getAttribute("data-approve");
        const cur = await pullRemote();
        const r = (cur.requests || []).find(function (x) { return x.id === id; });
        if (!r) return;
        if (!confirm("「" + r.query + "」のDropbox検索を承認して実行しますか？")) return;
        try {
          toast("承認・検索中…");
          await runSearch(r.query);
          r.status = "approved";
          r.updatedAt = new Date().toISOString();
          r.approvedBy = who().name;
          saveLocal(cur);
          await pushRemote(cur);
          syncBtn(cur);
          renderPanel(cur);
          toast("承認して検索しました");
        } catch (e) {
          toast("検索失敗: " + (e.message || e));
        }
      });
    });
    panel.querySelectorAll("[data-reject]").forEach(function (btn) {
      btn.addEventListener("click", async function () {
        if (!isPresident()) return;
        const id = btn.getAttribute("data-reject");
        const cur = await pullRemote();
        const r = (cur.requests || []).find(function (x) { return x.id === id; });
        if (!r) return;
        r.status = "rejected";
        r.updatedAt = new Date().toISOString();
        saveLocal(cur);
        await pushRemote(cur);
        syncBtn(cur);
        postToEntaku("Dropbox検索「" + r.query + "」は社長により却下されました。");
        renderPanel(cur);
      });
    });
  }

  async function openPanel() {
    const panel = ensurePanel();
    if (!panel) return;
    panel.hidden = false;
    const data = await pullRemote();
    syncBtn(data);
    renderPanel(data);
  }

  function wire() {
    const btn = document.getElementById("entakuDbxSearchBtn");
    if (!btn || btn.dataset.wired) return;
    btn.dataset.wired = "1";
    btn.addEventListener("click", function () {
      openPanel();
    });
    syncBtn(loadLocal());
    /* 社長向け：定期的に承認待ちを同期 */
    setInterval(async function () {
      if (!isPresident()) return;
      try {
        const data = await pullRemote();
        syncBtn(data);
        const panel = document.getElementById("entakuDbxPanel");
        if (panel && !panel.hidden) renderPanel(data);
      } catch (e) {}
    }, 45000);
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", wire);
  else wire();
  window.addEventListener("portal-member-ready", function () {
    syncBtn(loadLocal());
  });

  window.EntakuDbxSearch = { open: openPanel, pullRemote: pullRemote };
})();
