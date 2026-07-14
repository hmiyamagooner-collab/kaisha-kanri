/* =========================================================
   CF 印籠システム — 口座CSV・案件・突合・予測・印籠レポート
   gooner-portal.html の Treasury API に依存
   ========================================================= */
(function () {
  "use strict";
  const T = () => window.Treasury;
  if (!T()) {
    console.warn("[cf-inrou] Treasury not ready");
    return;
  }

  const CASE_TYPES = {
    sale: "売買",
    loan: "金消契約",
    related_loan: "個人会社貸借",
    tax: "税金",
  };
  const OWNER_JA = { company: "自社", personal: "個人会社", other: "その他" };

  function uid() {
    return crypto.randomUUID ? crypto.randomUUID() : "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }
  function today() {
    return new Date().toISOString().slice(0, 10);
  }
  function addDays(iso, n) {
    const d = new Date(iso + "T12:00:00");
    d.setDate(d.getDate() + n);
    return d.toISOString().slice(0, 10);
  }
  function simpleHash(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return ("00000000" + (h >>> 0).toString(16)).slice(-8);
  }
  function rowHash(r) {
    return simpleHash([r.date, r.amount, r.memo || "", r.balance ?? "", r.accountId || ""].join("|"));
  }

  /* ---------- migrate ---------- */
  function migrate() {
    const S = T().S;
    if (!S.accounts) S.accounts = [];
    if (!S.bankTx) S.bankTx = [];
    if (!S.cases) S.cases = [];
    if (!S.relatedParties) S.relatedParties = [];
    if (!S.caseLinks) S.caseLinks = [];
    if (!S.schedules) S.schedules = [];
    if (!S.auditLog) S.auditLog = [];
    if (!S.importBatches) S.importBatches = [];
    if (!S.cfVersion || S.cfVersion < 2) {
      if (!S.accounts.length) {
        S.accounts.push({
          id: uid(),
          name: "メイン口座（仮）",
          bank: "未設定",
          owner: "company",
          note: "CSV取込時に編集してください",
          createdAt: today(),
        });
      }
      if (!S.relatedParties.length) {
        S.relatedParties.push({
          id: uid(),
          name: "個人会社（仮）",
          kind: "personal_co",
          note: "関連者貸借の相手",
          createdAt: today(),
        });
      }
      // 旧手入力台帳は残しつつ、印籠側の監査に記録
      audit("migrate", "CF v2 データ構造を初期化（旧tx台帳は維持）");
      S.cfVersion = 2;
      T().saveAll();
    }
  }

  function audit(action, detail, meta) {
    const S = T().S;
    S.auditLog.unshift({
      id: uid(),
      at: new Date().toISOString(),
      by: T().role === "boss" ? "承認者" : "社員",
      action,
      detail,
      meta: meta || null,
    });
    if (S.auditLog.length > 500) S.auditLog.length = 500;
  }

  /* ---------- CSV parse ---------- */
  function parseCSV(text) {
    const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/).filter((l) => l.trim().length);
    if (!lines.length) return { headers: [], rows: [] };
    const split = (line) => {
      const out = [];
      let cur = "",
        q = false;
      for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (c === '"') {
          if (q && line[i + 1] === '"') {
            cur += '"';
            i++;
          } else q = !q;
        } else if (c === "," && !q) {
          out.push(cur);
          cur = "";
        } else cur += c;
      }
      out.push(cur);
      return out.map((s) => s.trim());
    };
    const headers = split(lines[0]);
    const rows = lines.slice(1).map(split).filter((r) => r.some((c) => c));
    return { headers, rows };
  }

  function guessMap(headers) {
    const h = headers.map((x) => x.toLowerCase());
    const find = (...keys) => {
      for (const k of keys) {
        const i = h.findIndex((x) => x.includes(k));
        if (i >= 0) return i;
      }
      return -1;
    };
    return {
      date: find("日付", "取引日", "年月日", "date"),
      amount: find("金額", "お預り", "お引", "出金", "入金", "amount"),
      deposit: find("入金", "お預り金額", "預り"),
      withdraw: find("出金", "お支払い金額", "支払"),
      memo: find("摘要", "内容", "適用", "memo", "備考", "取引先"),
      balance: find("残高", "balance"),
    };
  }

  function numJP(s) {
    if (s == null || s === "") return null;
    const n = Number(String(s).replace(/[,￥¥円\s]/g, "").replace(/▲|△|−/g, "-"));
    return Number.isFinite(n) ? n : null;
  }

  function normDate(s) {
    if (!s) return "";
    const t = String(s).trim().replace(/[./年]/g, "-").replace(/月/g, "-").replace(/日/g, "");
    const m = t.match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    if (m) return `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`;
    const m2 = t.match(/(\d{2})-(\d{1,2})-(\d{1,2})/);
    if (m2) return `20${m2[1]}-${m2[2].padStart(2, "0")}-${m2[3].padStart(2, "0")}`;
    return "";
  }

  let csvPreview = null; // {headers, rows, map, accountId}

  /* ---------- render helpers ---------- */
  function linkedCaseIds(txId) {
    return T().S.caseLinks.filter((l) => l.bankTxId === txId).map((l) => l.caseId);
  }
  function linksForCase(caseId) {
    return T().S.caseLinks.filter((l) => l.caseId === caseId);
  }
  function bankForCase(caseId) {
    const ids = new Set(linksForCase(caseId).map((l) => l.bankTxId));
    return T().S.bankTx.filter((t) => ids.has(t.id));
  }
  function schedulesForCase(caseId) {
    return T().S.schedules.filter((s) => s.caseId === caseId).sort((a, b) => a.date.localeCompare(b.date));
  }
  function partyName(id) {
    const p = T().S.relatedParties.find((x) => x.id === id);
    return p ? p.name : "—";
  }
  function accountName(id) {
    const a = T().S.accounts.find((x) => x.id === id);
    return a ? a.name : "—";
  }
  function caseActual(c) {
    const txs = bankForCase(c.id);
    const inSum = txs.filter((t) => t.amount > 0).reduce((a, t) => a + t.amount, 0);
    const outSum = txs.filter((t) => t.amount < 0).reduce((a, t) => a + Math.abs(t.amount), 0);
    return { inSum, outSum, net: inSum - outSum, count: txs.length };
  }
  function matchRate(c) {
    const sched = schedulesForCase(c.id);
    if (!sched.length) return null;
    const done = sched.filter((s) => s.linkedBankTxId).length;
    return Math.round((done / sched.length) * 100);
  }

  /* ---------- 承認ワークフロー（案件） ---------- */
  // 社員が申請 → 承認者が承認/差戻し。誰がいつを auditLog に刻み、印籠の証拠にする。
  const AP_JA = { pending: "申請中", approved: "承認済", rejected: "差戻し" };
  function apStatusOf(c) {
    return c && c.apStatus ? c.apStatus : "pending";
  }
  function setCaseApproval(caseId, status) {
    const S = T().S;
    const c = S.cases.find((x) => x.id === caseId);
    if (!c) return;
    if ((status === "approved" || status === "rejected") && T().role !== "boss") {
      T().toast("承認・差戻しは「承認者」モードで行えます");
      return;
    }
    c.apStatus = status;
    c.apBy = T().role === "boss" ? "承認者" : "社員";
    c.apAt = new Date().toISOString();
    const label = status === "approved" ? "承認" : status === "rejected" ? "差戻し" : "承認申請";
    audit("case_" + status, `${label}: ${c.title}`, { caseId });
    T().saveAll();
    T().toast(`${label}しました`);
    openCaseFlow(caseId);
    renderCases();
  }

  /* ---------- screens ---------- */
  function renderAccounts() {
    const S = T().S;
    const box = document.getElementById("cfAccList");
    if (!box) return;
    box.innerHTML =
      S.accounts
        .map(
          (a) => `<div class="cf-card">
      <div class="cf-card-h"><b>${T().esc(a.name)}</b><span class="tag">${OWNER_JA[a.owner] || a.owner}</span></div>
      <div class="cf-meta">${T().esc(a.bank || "")} ${a.note ? "／ " + T().esc(a.note) : ""}</div>
      <div class="cf-meta">明細 ${S.bankTx.filter((t) => t.accountId === a.id).length} 件</div>
    </div>`
        )
        .join("") || `<div class="cf-empty">口座がありません。下から追加してください。</div>`;

    const sel = document.getElementById("cfCsvAccount");
    if (sel) {
      const prev = sel.value;
      sel.innerHTML = S.accounts.map((a) => `<option value="${a.id}">${T().esc(a.name)}</option>`).join("");
      if (prev && [...sel.options].some((o) => o.value === prev)) sel.value = prev;
    }
    const linkAcc = document.getElementById("cfLinkAccountFilter");
    if (linkAcc) {
      const prev = linkAcc.value;
      linkAcc.innerHTML =
        `<option value="">全口座</option>` + S.accounts.map((a) => `<option value="${a.id}">${T().esc(a.name)}</option>`).join("");
      if (prev && [...linkAcc.options].some((o) => o.value === prev)) linkAcc.value = prev;
    }
    renderImportHistory();
  }

  function renderImportHistory() {
    const box = document.getElementById("cfImportHistory");
    if (!box) return;
    const S = T().S;
    const snaps = S.accounts
      .map((a) => {
        const withBal = S.bankTx
          .filter((t) => t.accountId === a.id && t.balance != null)
          .sort((x, y) => y.date.localeCompare(x.date));
        const last = withBal[0];
        const cnt = S.bankTx.filter((t) => t.accountId === a.id).length;
        return `<div class="cf-meta">【${T().esc(a.name)}】明細 ${cnt} 件 ／ 直近残高 ${
          last ? T().yen(last.balance) + "（" + last.date + "）" : "—"
        }</div>`;
      })
      .join("");
    const batches = [...(S.importBatches || [])]
      .sort((a, b) => (b.at || "").localeCompare(a.at || ""))
      .slice(0, 12)
      .map(
        (b) =>
          `<div class="cf-sched">${(b.at || "").slice(0, 19).replace("T", " ")} ／ ${T().esc(b.fileName || "")} ／ +${b.added} skip ${b.skipped} ／ ${T().esc(
            accountName(b.accountId)
          )}</div>`
      )
      .join("");
    box.innerHTML =
      snaps +
      (batches
        ? `<div class="cf-col-t" style="margin-top:10px">取込バッチ</div>${batches}`
        : `<div class="cf-empty">まだCSV取込はありません。</div>`);
  }

  function renderParties() {
    const box = document.getElementById("cfPartyList");
    if (!box) return;
    const S = T().S;
    box.innerHTML =
      S.relatedParties
        .map((p) => {
          const loans = S.cases.filter((c) => c.type === "related_loan" && c.partyId === p.id);
          const bal = loans.reduce((sum, c) => {
            const act = caseActual(c);
            // 貸付なら当社→相手: 出金が残債感、借入なら入金
            return sum + (c.direction === "borrow" ? act.inSum - act.outSum : act.outSum - act.inSum);
          }, 0);
          return `<div class="cf-card">
          <div class="cf-card-h"><b>${T().esc(p.name)}</b><span class="tag">${p.kind === "personal_co" ? "個人会社" : "関連者"}</span></div>
          <div class="cf-meta">${T().esc(p.note || "")}</div>
          <div class="cf-amt ${bal >= 0 ? "in" : "out"}">貸借ネット目安 ${T().yen(Math.abs(bal))}（${bal >= 0 ? "当社有利寄り" : "相手有利寄り"}）</div>
          <div class="cf-meta">案件 ${loans.length} 件</div>
        </div>`;
        })
        .join("") || `<div class="cf-empty">関連者がありません。</div>`;

    const partySel = document.getElementById("cfCaseParty");
    if (partySel) {
      partySel.innerHTML =
        `<option value="">なし</option>` + S.relatedParties.map((p) => `<option value="${p.id}">${T().esc(p.name)}</option>`).join("");
    }
  }

  function renderCases() {
    const box = document.getElementById("cfCaseBoard");
    if (!box) return;
    const S = T().S;
    const filter = (document.getElementById("cfCaseFilter") || {}).value || "";
    const list = S.cases
      .filter((c) => !filter || c.type === filter)
      .sort((a, b) => (b.contractDate || "").localeCompare(a.contractDate || ""));
    box.innerHTML =
      list
        .map((c) => {
          const act = caseActual(c);
          const rate = matchRate(c);
          const flag = act.count === 0 ? "未突合" : rate != null && rate < 100 ? "突合途中" : "紐づけあり";
          return `<button type="button" class="cf-card cf-case" data-case="${c.id}">
          <div class="cf-card-h"><b>${T().esc(c.title)}</b><span class="cf-card-tags"><span class="tag">${CASE_TYPES[c.type] || c.type}</span><span class="ap-badge ap-${apStatusOf(c)}">${AP_JA[apStatusOf(c)]}</span></span></div>
          <div class="cf-meta">契約 ${T().esc(c.contractDate || "—")} ／ 相手 ${T().esc(c.counterparty || partyName(c.partyId))}</div>
          <div class="cf-meta">契約額 ${T().yen(c.amount || 0)} ／ 実績入 ${T().yen(act.inSum)} 出 ${T().yen(act.outSum)}</div>
          <div class="cf-flag ${flag === "未突合" ? "bad" : flag === "突合途中" ? "warn" : "ok"}">${flag}${rate != null ? " ・予定消化 " + rate + "%" : ""}</div>
        </button>`;
        })
        .join("") || `<div class="cf-empty">案件がありません。右のフォームから作成してください。</div>`;

    box.querySelectorAll("[data-case]").forEach((b) => {
      b.onclick = () => openCaseFlow(b.dataset.case);
    });

    const linkCase = document.getElementById("cfLinkCase");
    if (linkCase) {
      const prev = linkCase.value;
      linkCase.innerHTML = S.cases.map((c) => `<option value="${c.id}">${T().esc(c.title)}（${CASE_TYPES[c.type]}）</option>`).join("");
      if (prev && [...linkCase.options].some((o) => o.value === prev)) linkCase.value = prev;
    }
    const inrouCase = document.getElementById("cfInrouCase");
    if (inrouCase) {
      const prev = inrouCase.value;
      inrouCase.innerHTML =
        `<option value="">案件を選択</option>` +
        S.cases.map((c) => `<option value="${c.id}">${T().esc(c.title)}</option>`).join("");
      if (prev && [...inrouCase.options].some((o) => o.value === prev)) inrouCase.value = prev;
    }
  }

  function renderBankTxList() {
    const box = document.getElementById("cfBankList");
    if (!box) return;
    const S = T().S;
    const acc = (document.getElementById("cfLinkAccountFilter") || {}).value || "";
    const onlyUn = document.getElementById("cfLinkUnmatchedOnly")?.checked;
    let rows = [...S.bankTx].sort((a, b) => b.date.localeCompare(a.date) || b.importedAt.localeCompare(a.importedAt));
    if (acc) rows = rows.filter((t) => t.accountId === acc);
    if (onlyUn) rows = rows.filter((t) => !linkedCaseIds(t.id).length);
    box.innerHTML =
      rows
        .slice(0, 200)
        .map((t) => {
          const linked = linkedCaseIds(t.id);
          const flagged = t.needsExplain ? " flag-need" : "";
          return `<label class="cf-tx-row${flagged}">
          <input type="checkbox" data-btx="${t.id}">
          <span class="num">${t.date}</span>
          <span class="${t.amount >= 0 ? "in" : "out"}">${t.amount >= 0 ? "+" : "−"}${T().yen(Math.abs(t.amount))}</span>
          <span class="memo">${T().esc(t.memo || "")}</span>
          <span class="tag">${linked.length ? "紐づけ済" : "未突合"}</span>
          ${t.needsExplain ? '<span class="tag bad">要説明</span>' : ""}
        </label>`;
        })
        .join("") || `<div class="cf-empty">銀行明細がありません。CSVを取り込んでください。</div>`;
  }

  function openCaseFlow(caseId) {
    const S = T().S;
    const c = S.cases.find((x) => x.id === caseId);
    const panel = document.getElementById("cfFlowPanel");
    if (!c || !panel) return;
    // switch nav
    const btn = document.querySelector('.gamenav button[data-s="cf-flow"]');
    if (btn) btn.click();

    const act = caseActual(c);
    const sched = schedulesForCase(c.id);
    const txs = bankForCase(c.id);
    const contractAmt = c.amount || 0;
    const inflowSide = c.type === "sale" || c.direction === "borrow";
    const relevantActual = inflowSide ? act.inSum : act.outSum;
    const gap = contractAmt - relevantActual;

    /* ---- 資金フロー可視化データ（契約 vs 予定 vs 実績・時系列・要説明） ---- */
    const schedTotal = sched.reduce((a, s) => a + Math.abs(s.amount || 0), 0);
    const plannedTxIds = new Set(sched.filter((s) => s.linkedBankTxId).map((s) => s.linkedBankTxId));
    const unplannedTxs = txs.filter((t) => !plannedTxIds.has(t.id)); // 予定に無い口座実績＝要説明(マネロン赤信号)
    const unmetSched = sched.filter((s) => !s.linkedBankTxId); // 予定に実績が来ていない
    const barMax = Math.max(contractAmt, schedTotal, relevantActual, 1);
    const barPct = (v) => Math.max(0, Math.min(100, (v / barMax) * 100));
    const times = [c.contractDate, ...sched.map((s) => s.date), ...txs.map((t) => t.date)]
      .map((d) => Date.parse(d))
      .filter((n) => !isNaN(n));
    const minT = times.length ? Math.min(...times) : 0;
    const spanT = (times.length ? Math.max(...times) : 1) - minT || 1;
    const stripPos = (d) => {
      const t = Date.parse(d);
      return isNaN(t) ? 50 : 4 + ((t - minT) / spanT) * 92;
    };
    const marks = [];
    if (c.contractDate) marks.push({ d: c.contractDate, cls: "contract", lb: "契約" });
    sched.forEach((s) => marks.push({ d: s.date, cls: "sched" + (s.linkedBankTxId ? "" : " unmet"), lb: s.kind || "予定" }));
    txs.forEach((t) => {
      const bad = t.needsExplain || !plannedTxIds.has(t.id);
      marks.push({ d: t.date, cls: "actual" + (bad ? " bad" : ""), lb: (t.amount >= 0 ? "+" : "−") + T().yen(Math.abs(t.amount)) });
    });
    const dirLabel = inflowSide ? "入金" : "出金";
    const apSt = apStatusOf(c);
    const badVerdict = Math.abs(gap) > 1 || unplannedTxs.length > 0 || apSt !== "approved";
    const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
    const vizHtml = `
      <div class="cf-viz">
        <div class="cf-col-t">資金フロー（一目でわかる図）</div>
        <div class="cf-bars">
          <div class="cf-bar-row"><span class="cf-bar-lb">契約</span><div class="cf-bar-track"><div class="cf-bar-fill contract" style="width:${barPct(contractAmt).toFixed(1)}%"></div></div><span class="cf-bar-val">${T().yen(contractAmt)}</span></div>
          <div class="cf-bar-row"><span class="cf-bar-lb">予定</span><div class="cf-bar-track"><div class="cf-bar-fill sched" style="width:${barPct(schedTotal).toFixed(1)}%"></div></div><span class="cf-bar-val">${T().yen(schedTotal)}</span></div>
          <div class="cf-bar-row"><span class="cf-bar-lb">実績</span><div class="cf-bar-track"><div class="cf-bar-fill actual ${relevantActual + 1 < contractAmt ? "short" : ""}" style="width:${barPct(relevantActual).toFixed(1)}%"></div></div><span class="cf-bar-val">${T().yen(relevantActual)}</span></div>
        </div>
        <div class="cf-strip-wrap">
          <div class="cf-strip">
            ${marks
              .map(
                (m) =>
                  `<div class="cf-mark ${m.cls}" style="left:${stripPos(m.d).toFixed(1)}%" title="${T().esc(m.d + " " + m.lb)}"><span class="dot"></span></div>`
              )
              .join("")}
          </div>
          <div class="cf-strip-lbls"><span>${times.length ? iso(minT) : "—"}</span><span>${times.length ? iso(minT + spanT) : "—"}</span></div>
        </div>
        <div class="cf-verdict ${badVerdict ? "bad" : "ok"}">
          <div class="cf-vd"><span class="k">承認</span><span class="v ${apSt === "approved" ? "in" : "warn"}">${AP_JA[apSt]}</span></div>
          <div class="cf-vd"><span class="k">契約額</span><span class="v">${T().yen(contractAmt)}</span></div>
          <div class="cf-vd"><span class="k">実績（${dirLabel}）</span><span class="v ${inflowSide ? "in" : "out"}">${T().yen(relevantActual)}</span></div>
          <div class="cf-vd"><span class="k">契約との差額</span><span class="v ${Math.abs(gap) > 1 ? "out" : ""}">${T().yen(Math.abs(gap))}</span></div>
          <div class="cf-vd"><span class="k">未説明の入出金</span><span class="v ${unplannedTxs.length > 0 ? "warn" : ""}">${unplannedTxs.length} 件</span></div>
          <div class="cf-vd"><span class="k">未実績の予定</span><span class="v ${unmetSched.length > 0 ? "warn" : ""}">${unmetSched.length} 件</span></div>
        </div>
        <div class="cf-legend">
          <span><i style="background:var(--gold)"></i>契約</span>
          <span><i style="background:var(--tax)"></i>予定</span>
          <span><i style="background:var(--in)"></i>実績（説明済）</span>
          <span><i style="background:var(--out)"></i>要説明・予定外</span>
        </div>
      </div>`;

    /* ---- 承認バッジ＆操作ボタン（役割で出し分け） ---- */
    const apBadge =
      `<span class="ap-badge ap-${apSt}">${AP_JA[apSt]}</span>` +
      (c.apAt ? `<span class="ap-by">${iso(Date.parse(c.apAt))} ${T().esc(c.apBy || "")}</span>` : "");
    let apBtns = "";
    if (apSt === "pending" && T().role === "boss")
      apBtns = `<button type="button" class="csv-btn" data-ap="approved">承認する</button><button type="button" class="csv-btn ghost" data-ap="rejected">差戻し</button>`;
    else if (apSt === "pending")
      apBtns = `<span class="cf-meta">承認者の承認待ちです</span>`;
    else if (apSt === "approved" && T().role === "boss")
      apBtns = `<button type="button" class="csv-btn ghost" data-ap="rejected">承認を取消</button>`;
    else if (apSt === "rejected")
      apBtns = `<button type="button" class="csv-btn" data-ap="pending">再申請する</button>`;

    panel.innerHTML = `
      <div class="cf-flow-head">
        <h3>${T().esc(c.title)}</h3>
        <span class="tag">${CASE_TYPES[c.type]}</span>
        ${apBadge}
        <button type="button" class="csv-btn" id="cfFlowInrou">この案件の印籠を開く</button>
        <span class="cf-ap-actions">${apBtns}</span>
      </div>
      <p class="sdesc" style="margin-bottom:12px">契約・予定・実績の三点を並べます。差があれば赤で示します（社内牽制用・AML届出そのものではありません）。</p>
      ${vizHtml}
      <div class="cf-flow-grid">
        <div class="cf-flow-col">
          <div class="cf-col-t">① 契約</div>
          <div>相手: <b>${T().esc(c.counterparty || partyName(c.partyId))}</b></div>
          <div>締結: ${T().esc(c.contractDate || "—")}</div>
          <div>金額: <b>${T().yen(contractAmt)}</b></div>
          <div>利率: ${c.rate != null ? c.rate + "%" : "—"}</div>
          <div class="cf-meta">${T().esc(c.contractNote || "")}</div>
        </div>
        <div class="cf-flow-col">
          <div class="cf-col-t">② 予定スケジュール</div>
          ${
            sched
              .map(
                (s) =>
                  `<div class="cf-sched ${s.linkedBankTxId ? "ok" : "warn"}">${s.date} ${s.kind} ${T().yen(s.amount)} ${s.linkedBankTxId ? "✓" : "未実績"}</div>`
              )
              .join("") || `<div class="cf-empty">予定なし（案件編集で追加可）</div>`
          }
        </div>
        <div class="cf-flow-col">
          <div class="cf-col-t">③ 口座実績</div>
          <div>入金 ${T().yen(act.inSum)} ／ 出金 ${T().yen(act.outSum)}（${act.count}件）</div>
          ${
            txs
              .map(
                (t) =>
                  `<div class="cf-sched ${t.needsExplain ? "bad" : "ok"}">${t.date} ${t.amount >= 0 ? "+" : "−"}${T().yen(Math.abs(t.amount))} ${T().esc(t.memo || "")}</div>`
              )
              .join("") || `<div class="cf-empty bad">未突合 — 明細を案件に紐づけてください</div>`
          }
        </div>
      </div>
      <div class="cf-gap ${Math.abs(gap) > 1 ? "bad" : "ok"}">契約との差額目安: ${T().yen(Math.abs(gap))} ${Math.abs(gap) > 1 ? "（要確認）" : "（概ね一致）"}</div>
      <div class="cf-timeline">
        <div class="cf-col-t">時系列</div>
        ${buildTimeline(c, sched, txs)}
      </div>`;

    const ib = document.getElementById("cfFlowInrou");
    if (ib) {
      ib.onclick = () => {
        const sel = document.getElementById("cfInrouCase");
        if (sel) sel.value = c.id;
        document.querySelector('.gamenav button[data-s="cf-inrou"]')?.click();
        renderInrou();
      };
    }
    panel.querySelectorAll("[data-ap]").forEach((b) => {
      b.onclick = () => setCaseApproval(c.id, b.dataset.ap);
    });
  }

  function buildTimeline(c, sched, txs) {
    const events = [];
    if (c.contractDate) events.push({ date: c.contractDate, label: "契約", cls: "contract" });
    sched.forEach((s) => events.push({ date: s.date, label: `予定 ${s.kind} ${T().yen(s.amount)}`, cls: "sched" }));
    txs.forEach((t) =>
      events.push({
        date: t.date,
        label: `実績 ${t.amount >= 0 ? "+" : "−"}${T().yen(Math.abs(t.amount))} ${t.memo || ""}`,
        cls: t.needsExplain ? "bad" : "actual",
      })
    );
    events.sort((a, b) => a.date.localeCompare(b.date));
    return (
      events.map((e) => `<div class="cf-tl ${e.cls}"><span class="num">${e.date}</span> ${T().esc(e.label)}</div>`).join("") ||
      `<div class="cf-empty">イベントなし</div>`
    );
  }

  function renderForecast() {
    const box = document.getElementById("cfForecastBody");
    if (!box) return;
    const S = T().S;
    const days = +(document.getElementById("cfForecastDays") || { value: 90 }).value || 90;
    const start = today();
    const end = addDays(start, days);

    // starting balance: latest bankTx balance if any
    let bal = 0;
    const withBal = [...S.bankTx].filter((t) => t.balance != null).sort((a, b) => b.date.localeCompare(a.date));
    if (withBal.length) bal = withBal[0].balance;
    else {
      bal = S.bankTx.reduce((a, t) => a + t.amount, 0);
    }

    const sched = S.schedules
      .filter((s) => s.date >= start && s.date <= end && !s.linkedBankTxId)
      .sort((a, b) => a.date.localeCompare(b.date));

    // unexpected: bank txs in window without schedule match / without case link
    const unexpected = S.bankTx.filter((t) => t.date >= start && t.date <= end && (t.needsExplain || !linkedCaseIds(t.id).length));

    let running = bal;
    let minBal = bal;
    const rows = [];
    sched.forEach((s) => {
      const signed = s.kind === "in" || s.kind === "interest_in" ? s.amount : -Math.abs(s.amount);
      running += signed;
      if (running < minBal) minBal = running;
      rows.push({ date: s.date, label: s.kind, amount: signed, bal: running, caseId: s.caseId });
    });

    document.getElementById("cfForecastStart").textContent = T().yen(bal);
    document.getElementById("cfForecastMin").textContent = T().yen(minBal);
    document.getElementById("cfForecastMin").className = "val " + (minBal < 0 ? "out" : "net");

    box.innerHTML =
      `<div class="cf-alert-box">
        <b>予定外・未突合シグナル（${unexpected.length}件）</b>
        <div class="cf-meta">大口や案件未紐づけの入出金。会長の想定外入出金・説明不能な動きの早期発見用です。</div>
        ${
          unexpected
            .slice(0, 30)
            .map(
              (t) =>
                `<div class="cf-sched bad">${t.date} ${t.amount >= 0 ? "+" : "−"}${T().yen(Math.abs(t.amount))} ${T().esc(t.memo || "")} ${t.needsExplain ? "【要説明】" : "【未突合】"}</div>`
            )
            .join("") || `<div class="cf-empty ok">該当なし</div>`
        }
      </div>
      <div class="cf-col-t" style="margin-top:14px">予定キャッシュフロー</div>
      ${
        rows
          .map((r) => {
            const c = S.cases.find((x) => x.id === r.caseId);
            return `<div class="cf-sched">${r.date} ${r.amount >= 0 ? "+" : "−"}${T().yen(Math.abs(r.amount))} → 残高見込 ${T().yen(r.bal)} <span class="cf-meta">${T().esc(c ? c.title : "")}</span></div>`;
          })
          .join("") || `<div class="cf-empty">期間内の未消化予定はありません</div>`
      }`;
  }

  function renderInrou() {
    const caseId = (document.getElementById("cfInrouCase") || {}).value;
    const out = document.getElementById("cfInrouReport");
    if (!out) return;
    if (!caseId) {
      out.innerHTML = `<div class="cf-empty">案件を選ぶと印籠レポートが生成されます。</div>`;
      return;
    }
    const S = T().S;
    const c = S.cases.find((x) => x.id === caseId);
    if (!c) return;
    const act = caseActual(c);
    const sched = schedulesForCase(c.id);
    const txs = bankForCase(c.id);
    const unmatched = S.bankTx.filter((t) => !linkedCaseIds(t.id).length).slice(0, 20);
    const logs = S.auditLog.filter((a) => !a.meta || a.meta.caseId === caseId || a.action.includes("case") || a.action.includes("link")).slice(0, 30);
    const payload = JSON.stringify({
      case: c,
      act,
      sched,
      txs: txs.map((t) => ({ id: t.id, date: t.date, amount: t.amount, memo: t.memo, hash: t.hash })),
    });
    const hash = simpleHash(payload);
    const genAt = new Date().toISOString();

    out.innerHTML = `
      <div class="inrou-sheet" id="inrouSheet">
        <div class="inrou-seal">印籠</div>
        <h2>案件証拠レポート — ${T().esc(c.title)}</h2>
        <p class="cf-meta">生成: ${genAt} ／ 内容ハッシュ: <code>${hash}</code></p>
        <p class="note">本レポートは社内の可視化・牽制のための証拠資料です。法令上のAML届出や当局手続そのものではありません。</p>
        <h3>契約</h3>
        <table class="ledger"><tbody>
          <tr><td>種別</td><td>${CASE_TYPES[c.type]}</td></tr>
          <tr><td>相手</td><td>${T().esc(c.counterparty || partyName(c.partyId))}</td></tr>
          <tr><td>締結日</td><td>${T().esc(c.contractDate || "—")}</td></tr>
          <tr><td>契約額</td><td>${T().yen(c.amount || 0)}</td></tr>
          <tr><td>利率</td><td>${c.rate != null ? c.rate + "%" : "—"}</td></tr>
          <tr><td>メモ</td><td>${T().esc(c.contractNote || "")}</td></tr>
          <tr><td>承認状態</td><td><b class="${apStatusOf(c) === "approved" ? "" : "cf-warn"}">${AP_JA[apStatusOf(c)]}</b>${c.apAt ? `（${T().esc(c.apBy || "")} ／ ${c.apAt.slice(0, 10)}）` : "（未承認）"}</td></tr>
        </tbody></table>
        <h3>予定</h3>
        <table class="ledger"><thead><tr><th>日付</th><th>区分</th><th>金額</th><th>実績紐づけ</th></tr></thead>
        <tbody>${
          sched
            .map(
              (s) =>
                `<tr><td>${s.date}</td><td>${s.kind}</td><td class="num">${T().yen(s.amount)}</td><td>${s.linkedBankTxId ? "済" : "未"}</td></tr>`
            )
            .join("") || `<tr><td colspan="4">なし</td></tr>`
        }</tbody></table>
        <h3>突合済み口座明細</h3>
        <table class="ledger"><thead><tr><th>日付</th><th>金額</th><th>摘要</th><th>行ハッシュ</th></tr></thead>
        <tbody>${
          txs
            .map(
              (t) =>
                `<tr><td>${t.date}</td><td class="num">${t.amount}</td><td>${T().esc(t.memo || "")}</td><td class="num">${t.hash || ""}</td></tr>`
            )
            .join("") || `<tr><td colspan="4" class="bad">未突合</td></tr>`
        }</tbody></table>
        <h3>実績サマリ</h3>
        <p>入金 ${T().yen(act.inSum)} ／ 出金 ${T().yen(act.outSum)} ／ 件数 ${act.count}</p>
        <h3>参考：未突合明細（抜粋）</h3>
        <table class="ledger"><thead><tr><th>日付</th><th>金額</th><th>摘要</th></tr></thead>
        <tbody>${
          unmatched
            .map((t) => `<tr><td>${t.date}</td><td class="num">${t.amount}</td><td>${T().esc(t.memo || "")}</td></tr>`)
            .join("") || `<tr><td colspan="3">なし</td></tr>`
        }</tbody></table>
        <h3>操作ログ（抜粋）</h3>
        <table class="ledger"><thead><tr><th>時刻</th><th>誰</th><th>内容</th></tr></thead>
        <tbody>${
          logs
            .map((a) => `<tr><td>${a.at}</td><td>${T().esc(a.by)}</td><td>${T().esc(a.detail)}</td></tr>`)
            .join("") || `<tr><td colspan="3">なし</td></tr>`
        }</tbody></table>
      </div>`;
  }

  function renderCFAll() {
    renderAccounts();
    renderParties();
    renderCases();
    renderBankTxList();
    renderForecast();
    if ((document.getElementById("cfInrouCase") || {}).value) renderInrou();
  }

  /* ---------- actions ---------- */
  function bind() {
    document.getElementById("cfAddAccount")?.addEventListener("click", () => {
      const name = document.getElementById("cfAccName").value.trim();
      if (!name) return T().toast("口座名は必須です");
      const S = T().S;
      S.accounts.push({
        id: uid(),
        name,
        bank: document.getElementById("cfAccBank").value.trim(),
        owner: document.getElementById("cfAccOwner").value,
        note: document.getElementById("cfAccNote").value.trim(),
        createdAt: today(),
      });
      audit("account_add", `口座追加: ${name}`);
      T().saveAll();
      document.getElementById("cfAccName").value = "";
      renderCFAll();
      T().toast("口座を追加しました");
    });

    document.getElementById("cfAddParty")?.addEventListener("click", () => {
      const name = document.getElementById("cfPartyName").value.trim();
      if (!name) return T().toast("名称は必須です");
      T().S.relatedParties.push({
        id: uid(),
        name,
        kind: document.getElementById("cfPartyKind").value,
        note: document.getElementById("cfPartyNote").value.trim(),
        createdAt: today(),
      });
      audit("party_add", `関連者追加: ${name}`);
      T().saveAll();
      document.getElementById("cfPartyName").value = "";
      renderCFAll();
      T().toast("関連者を追加しました");
    });

    document.getElementById("cfCsvFile")?.addEventListener("change", async (ev) => {
      const f = ev.target.files && ev.target.files[0];
      if (!f) return;
      const text = await f.text();
      const { headers, rows } = parseCSV(text);
      const map = guessMap(headers);
      csvPreview = { headers, rows, map, accountId: document.getElementById("cfCsvAccount").value, fileName: f.name };
      showCsvMapUI();
    });

    document.getElementById("cfCsvCommit")?.addEventListener("click", commitCsv);
    document.getElementById("cfCaseSave")?.addEventListener("click", saveCaseWrapped);
    document.getElementById("cfCaseType")?.addEventListener("change", () => {
      const t = document.getElementById("cfCaseType").value;
      document.getElementById("cfCasePartyWrap").style.display = t === "related_loan" ? "" : "none";
      document.getElementById("cfCaseDirWrap").style.display = t === "loan" || t === "related_loan" ? "" : "none";
      document.getElementById("cfCaseRateWrap").style.display = t === "loan" || t === "related_loan" ? "" : "none";
    });
    document.getElementById("cfCaseFilter")?.addEventListener("change", renderCases);
    document.getElementById("cfLinkAccountFilter")?.addEventListener("change", renderBankTxList);
    document.getElementById("cfLinkUnmatchedOnly")?.addEventListener("change", renderBankTxList);
    document.getElementById("cfLinkBtn")?.addEventListener("click", linkSelected);
    document.getElementById("cfForecastDays")?.addEventListener("change", renderForecast);
    document.getElementById("cfInrouCase")?.addEventListener("change", renderInrou);
    document.getElementById("cfInrouPrint")?.addEventListener("click", () => {
      renderInrou();
      window.print();
    });
    document.getElementById("cfInrouCsv")?.addEventListener("click", exportInrouCsv);
    document.getElementById("cfGenLoanSched")?.addEventListener("click", genLoanScheduleFromForm);
  }

  function showCsvMapUI() {
    const box = document.getElementById("cfCsvMap");
    if (!box || !csvPreview) return;
    const opts = csvPreview.headers.map((h, i) => `<option value="${i}">${i}: ${T().esc(h)}</option>`).join("");
    const m = csvPreview.map;
    const sel = (id, val) =>
      `<select id="${id}"><option value="-1">（使わない）</option>${csvPreview.headers
        .map((h, i) => `<option value="${i}" ${i === val ? "selected" : ""}>${i}: ${T().esc(h)}</option>`)
        .join("")}</select>`;
    box.style.display = "";
    box.innerHTML = `
      <div class="cf-meta">ファイル: ${T().esc(csvPreview.fileName)} ／ ${csvPreview.rows.length} 行</div>
      <div class="entry-grid" style="margin-top:10px">
        <div class="fgroup"><label>日付列</label>${sel("mapDate", m.date)}</div>
        <div class="fgroup"><label>摘要列</label>${sel("mapMemo", m.memo)}</div>
        <div class="fgroup"><label>金額列（1列の場合）</label>${sel("mapAmount", m.amount)}</div>
        <div class="fgroup"><label>入金列（分離形式）</label>${sel("mapDeposit", m.deposit)}</div>
        <div class="fgroup"><label>出金列（分離形式）</label>${sel("mapWithdraw", m.withdraw)}</div>
        <div class="fgroup"><label>残高列</label>${sel("mapBalance", m.balance)}</div>
      </div>
      <div class="cf-meta" style="margin-top:8px">プレビュー（先頭5行）</div>
      <pre class="cf-pre">${T().esc(
        csvPreview.rows
          .slice(0, 5)
          .map((r) => r.join(" | "))
          .join("\n")
      )}</pre>
      <label class="expense-check" style="margin-top:10px">
        <input type="checkbox" id="cfFlagLarge" checked>
        <span>予定外の可能性として、絶対額50万円以上を「要説明」フラグにする</span>
      </label>`;
  }

  function commitCsv() {
    if (!csvPreview) return T().toast("先にCSVを選んでください");
    const S = T().S;
    const accountId = document.getElementById("cfCsvAccount").value || csvPreview.accountId;
    if (!accountId) return T().toast("取込先口座を選んでください");
    const gi = (id) => +(document.getElementById(id)?.value ?? -1);
    const iDate = gi("mapDate"),
      iMemo = gi("mapMemo"),
      iAmt = gi("mapAmount"),
      iDep = gi("mapDeposit"),
      iWd = gi("mapWithdraw"),
      iBal = gi("mapBalance");
    const flagLarge = document.getElementById("cfFlagLarge")?.checked;
    const batchId = uid();
    let added = 0,
      skipped = 0;
    const existing = new Set(S.bankTx.map((t) => t.hash));

    csvPreview.rows.forEach((r) => {
      const date = normDate(iDate >= 0 ? r[iDate] : "");
      if (!date) {
        skipped++;
        return;
      }
      let amount = null;
      if (iDep >= 0 || iWd >= 0) {
        const dep = iDep >= 0 ? numJP(r[iDep]) : 0;
        const wd = iWd >= 0 ? numJP(r[iWd]) : 0;
        amount = (dep || 0) - (wd || 0);
      } else if (iAmt >= 0) {
        amount = numJP(r[iAmt]);
      }
      if (amount == null || amount === 0) {
        skipped++;
        return;
      }
      const memo = iMemo >= 0 ? r[iMemo] || "" : "";
      const balance = iBal >= 0 ? numJP(r[iBal]) : null;
      const rec = {
        id: uid(),
        accountId,
        date,
        amount,
        memo,
        balance,
        batchId,
        importedAt: new Date().toISOString(),
        source: "csv",
        immutable: true,
        needsExplain: !!(flagLarge && Math.abs(amount) >= 500000),
      };
      rec.hash = rowHash(rec);
      if (existing.has(rec.hash)) {
        skipped++;
        return;
      }
      existing.add(rec.hash);
      S.bankTx.push(rec);
      added++;
    });

    S.importBatches.push({
      id: batchId,
      accountId,
      fileName: csvPreview.fileName,
      at: new Date().toISOString(),
      added,
      skipped,
    });
    audit("csv_import", `CSV取込 ${csvPreview.fileName}: +${added} / skip ${skipped}`, { batchId, accountId });
    T().saveAll();
    csvPreview = null;
    document.getElementById("cfCsvMap").style.display = "none";
    document.getElementById("cfCsvFile").value = "";
    renderCFAll();
    T().toast(`取込完了: ${added}件追加（重複等スキップ ${skipped}）`);
  }

  function saveCase() {
    const S = T().S;
    const title = document.getElementById("cfCaseTitle").value.trim();
    if (!title) {
      T().toast("案件名は必須です");
      return null;
    }
    const type = document.getElementById("cfCaseType").value;
    const c = {
      id: uid(),
      title,
      type,
      counterparty: document.getElementById("cfCaseWho").value.trim(),
      partyId: document.getElementById("cfCaseParty").value || null,
      direction: document.getElementById("cfCaseDir").value,
      contractDate: document.getElementById("cfCaseDate").value || today(),
      amount: +document.getElementById("cfCaseAmt").value || 0,
      rate: document.getElementById("cfCaseRate").value === "" ? null : +document.getElementById("cfCaseRate").value,
      contractNote: document.getElementById("cfCaseNote").value.trim(),
      createdAt: today(),
      apStatus: "pending", // 作成時は「申請中」。承認者が承認するまで印籠は未承認扱い
    };
    S.cases.push(c);
    audit("case_add", `案件作成（承認申請）: ${title}`, { caseId: c.id });

    // optional first schedule
    const schedDate = document.getElementById("cfCaseSchedDate").value;
    const schedAmt = +document.getElementById("cfCaseSchedAmt").value;
    const schedKind = document.getElementById("cfCaseSchedKind").value;
    if (schedDate && schedAmt) {
      S.schedules.push({
        id: uid(),
        caseId: c.id,
        date: schedDate,
        amount: schedAmt,
        kind: schedKind,
        linkedBankTxId: null,
      });
    }

    T().saveAll();
    document.getElementById("cfCaseTitle").value = "";
    document.getElementById("cfCaseAmt").value = "";
    renderCFAll();
    T().toast("案件を作成しました");
    openCaseFlow(c.id);
    return c;
  }

  function genLoanScheduleFromForm() {
    const principal = +document.getElementById("cfCaseAmt").value || 0;
    const rate = +document.getElementById("cfCaseRate").value || 0;
    const start = document.getElementById("cfCaseDate").value || today();
    const months = +document.getElementById("cfLoanMonths").value || 12;
    if (!principal) return T().toast("契約額を入れてください");
    const monthly = Math.round(principal / months);
    const lines = [];
    for (let i = 1; i <= months; i++) {
      const d = addDays(start, i * 30);
      const interest = Math.round((principal - monthly * (i - 1)) * (rate / 100) / 12);
      lines.push({ date: d, amount: monthly + Math.max(0, interest), kind: "out" });
    }
    window._pendingLoanSched = lines;
    T().toast(`金消スケジュール案 ${months}回を準備。案件保存時に登録します`);
  }

  function saveCaseWrapped() {
    const c = saveCase();
    if (!c) return;
    const S = T().S;
    if (window._pendingLoanSched && (c.type === "loan" || c.type === "related_loan")) {
      window._pendingLoanSched.forEach((s) => {
        S.schedules.push({ id: uid(), caseId: c.id, date: s.date, amount: s.amount, kind: s.kind, linkedBankTxId: null });
      });
      window._pendingLoanSched = null;
      audit("sched_gen", `金消スケジュール自動生成`, { caseId: c.id });
      T().saveAll();
      renderCFAll();
      openCaseFlow(c.id);
    }
  }

  function linkSelected() {
    const caseId = document.getElementById("cfLinkCase").value;
    if (!caseId) return T().toast("案件を選んでください");
    const checks = [...document.querySelectorAll("#cfBankList input[data-btx]:checked")];
    if (!checks.length) return T().toast("明細を選択してください");
    const S = T().S;
    let n = 0;
    checks.forEach((ch) => {
      const bankTxId = ch.dataset.btx;
      if (S.caseLinks.some((l) => l.bankTxId === bankTxId && l.caseId === caseId)) return;
      S.caseLinks.push({ id: uid(), caseId, bankTxId, at: new Date().toISOString(), by: T().role });
      const tx = S.bankTx.find((t) => t.id === bankTxId);
      if (tx) {
        const sched = schedulesForCase(caseId).find(
          (s) => !s.linkedBankTxId && s.date === tx.date && Math.abs(s.amount - Math.abs(tx.amount)) < 1
        );
        if (sched) sched.linkedBankTxId = bankTxId;
      }
      n++;
    });
    audit("link", `${n}件の明細を案件に紐づけ`, { caseId });
    T().saveAll();
    renderCFAll();
    openCaseFlow(caseId);
    T().toast(`${n}件を紐づけました`);
  }

  function exportInrouCsv() {
    const caseId = document.getElementById("cfInrouCase").value;
    if (!caseId) return T().toast("案件を選択してください");
    const S = T().S;
    const c = S.cases.find((x) => x.id === caseId);
    const txs = bankForCase(caseId);
    const head = ["案件", "種別", "日付", "金額", "摘要", "行ハッシュ", "口座"];
    const rows = txs.map((t) => [c.title, CASE_TYPES[c.type], t.date, t.amount, t.memo || "", t.hash || "", accountName(t.accountId)]);
    const csv =
      "\uFEFF" +
      [head, ...rows].map((r) => r.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    a.download = `inrou_${c.title}_${today()}.csv`;
    a.click();
    audit("inrou_csv", `印籠CSV出力: ${c.title}`, { caseId });
    T().saveAll();
    T().toast("印籠CSVを書き出しました");
  }

  /* ---------- init ---------- */
  function init() {
    migrate();
    bind();
    const d = today();
    ["cfCaseDate", "cfCaseSchedDate"].forEach((id) => {
      const el = document.getElementById(id);
      if (el && !el.value) el.value = d;
    });
    document.getElementById("cfCaseType")?.dispatchEvent(new Event("change"));
    T().onRender(renderCFAll);
    renderCFAll();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
  else init();
})();
