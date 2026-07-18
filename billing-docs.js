/* 請求・見積書 / 領収書 — 利益率25%社長決裁・下請けPDF原価・印刷・Dropbox保管確認 */
(function () {
  const MIN_MARGIN = 0.25;
  const LS_INV = "gp_billing_invoices_v1";
  const LS_RCP = "gp_billing_receipts_v1";
  const DBX_INV = "/GoonerPortal/請求書";
  const DBX_RCP = "/GoonerPortal/領収書";

  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }
  function yen(n) {
    return "¥" + Math.round(Number(n) || 0).toLocaleString("ja-JP");
  }
  function today() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function load(key) {
    try {
      return JSON.parse(localStorage.getItem(key) || "[]");
    } catch (e) {
      return [];
    }
  }
  function save(key, arr) {
    localStorage.setItem(key, JSON.stringify(arr.slice(0, 200)));
  }
  function toast(msg) {
    try {
      window.Treasury?.toast?.(msg);
    } catch (e) {}
    if (!window.Treasury?.toast) alert(msg);
  }
  function isPresident() {
    const m = window.GoonerSB?.me?.();
    const u = window.PortalAuth?.getUser?.();
    return (m && m.role === "社長") || (u && u.role === "社長");
  }
  function who() {
    const u = window.PortalAuth?.getUser?.() || {};
    return u.name || u.email || "担当者";
  }
  function uid(prefix) {
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7);
  }

  function injectStyles() {
    if (document.getElementById("billingDocsCss")) return;
    const st = document.createElement("style");
    st.id = "billingDocsCss";
    st.textContent = `
#billingInvoiceApp,#billingReceiptApp{color:var(--text)}
.bd-grid{display:grid;grid-template-columns:1.1fr .9fr;gap:14px}
@media(max-width:900px){.bd-grid{grid-template-columns:1fr}}
.bd-card{background:var(--panel,#111);border:1px solid var(--line,rgba(255,255,255,.2));border-radius:12px;padding:14px}
.bd-card h3{margin:0 0 10px;font-size:14px}
.bd-row{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:8px}
.bd-row.full{grid-template-columns:1fr}
.bd-field label{display:block;font-size:11px;color:var(--muted,#9aa);margin-bottom:4px}
.bd-field input,.bd-field select,.bd-field textarea{
  width:100%;box-sizing:border-box;background:var(--panel2,#0a0a0a);border:1px solid var(--line-strong,rgba(255,255,255,.35));
  border-radius:8px;color:var(--text,#fff);padding:8px 10px;font-size:13px;font-family:inherit
}
.bd-actions{display:flex;flex-wrap:wrap;gap:8px;margin-top:12px}
.bd-actions button,.bd-mini{
  border:none;border-radius:8px;padding:9px 14px;font-size:12px;font-weight:800;cursor:pointer;
  background:var(--nav-green,#33c6b3);color:#062012
}
.bd-actions button.secondary,.bd-mini.secondary{background:transparent;border:1px solid var(--line);color:var(--text)}
.bd-actions button.warn{background:#8a4b00;color:#fff8e8}
.bd-alert{
  margin:10px 0;padding:12px 14px;border-radius:10px;border-left:4px solid #e0a040;
  background:rgba(224,160,64,.12);color:#f0c878;font-size:13px;line-height:1.55
}
.bd-alert.ok{border-left-color:#33c6b3;background:rgba(51,198,179,.1);color:#9fe8dc}
.bd-alert.bad{border-left-color:#e07070;background:rgba(224,80,80,.12);color:#ffc0c0}
.bd-sheet{
  background:#fff;color:#1a1a1a;border-radius:4px;padding:28px 32px;min-height:420px;
  font-family:"Hiragino Mincho ProN","Yu Mincho","Noto Serif JP",serif;box-shadow:0 8px 28px rgba(0,0,0,.35)
}
.bd-sheet .bd-co{font-size:20px;font-weight:800;letter-spacing:.08em;margin:0 0 4px}
.bd-sheet .bd-meta{font-size:12px;color:#444;margin-bottom:18px}
.bd-sheet h4{margin:0 0 12px;font-size:22px;border-bottom:2px solid #222;padding-bottom:6px}
.bd-sheet table{width:100%;border-collapse:collapse;font-size:13px;margin:14px 0}
.bd-sheet th,.bd-sheet td{border:1px solid #bbb;padding:8px 10px;text-align:left}
.bd-sheet th{background:#f3f3f3}
.bd-sheet .num{text-align:right;font-variant-numeric:tabular-nums}
.bd-sheet .bd-total{margin-top:10px;text-align:right;font-size:16px;font-weight:800}
.bd-sheet .bd-stamp{margin-top:28px;display:flex;justify-content:flex-end;gap:24px}
.bd-sheet .bd-box{width:88px;height:88px;border:1px solid #888;display:flex;align-items:center;justify-content:center;font-size:11px;color:#666}
.bd-check{margin-top:12px;padding:12px;border:1px dashed rgba(255,255,255,.3);border-radius:10px;font-size:12px}
.bd-check li{margin:6px 0}
.bd-hist{max-height:220px;overflow:auto;font-size:12px}
.bd-hist button{margin-left:8px}
.bd-items .bd-item-row{display:grid;grid-template-columns:1.4fr .6fr .6fr auto;gap:6px;margin-bottom:6px;align-items:end}
@media print{
  body *{visibility:hidden!important}
  #bdPrintRoot,#bdPrintRoot *{visibility:visible!important}
  #bdPrintRoot{position:absolute;left:0;top:0;width:100%;background:#fff;padding:0}
}
`;
    document.head.appendChild(st);
  }

  function parseMoneyFromText(text) {
    const s = String(text || "");
    const amounts = [];
    const re = /(?:¥|￥|円)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})(?:\s*円)?/g;
    let m;
    while ((m = re.exec(s))) {
      const n = Number(String(m[1]).replace(/,/g, ""));
      if (n >= 1000) amounts.push(n);
    }
    amounts.sort((a, b) => b - a);
    const cost = amounts[0] || 0;
    const lines = [];
    s.split(/\r?\n/).forEach(function (line) {
      const am = line.match(/(?:¥|￥)?\s*([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,})\s*円?/);
      if (!am) return;
      const n = Number(String(am[1]).replace(/,/g, ""));
      if (n < 1000) return;
      const name = line.replace(am[0], "").replace(/[:：]/s*$/, "").trim().slice(0, 60) || "下請け項目";
      lines.push({ name: name, qty: 1, unit: n });
    });
    return { cost: cost, lines: lines.slice(0, 20), rawHits: amounts.slice(0, 8) };
  }

  async function extractPdfText(file) {
    if (!window.pdfjsLib) {
      await new Promise(function (resolve, reject) {
        const s = document.createElement("script");
        s.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
        s.onload = function () {
          if (!window.pdfjsLib) return reject(new Error("pdf.js未読込"));
          window.pdfjsLib.GlobalWorkerOptions.workerSrc =
            "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
          resolve();
        };
        s.onerror = reject;
        document.head.appendChild(s);
      });
    }
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: new Uint8Array(buf) }).promise;
    let text = "";
    const max = Math.min(pdf.numPages, 8);
    for (let i = 1; i <= max; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      text += content.items.map(function (it) { return it.str; }).join(" ") + "\n";
    }
    return text;
  }

  function marginInfo(sell, cost) {
    sell = Number(sell) || 0;
    cost = Number(cost) || 0;
    if (sell <= 0) return { rate: null, ok: true, profit: sell - cost };
    const profit = sell - cost;
    const rate = profit / sell;
    return { rate: rate, ok: rate >= MIN_MARGIN, profit: profit };
  }

  function printSheet(html) {
    let root = document.getElementById("bdPrintRoot");
    if (!root) {
      root = document.createElement("div");
      root.id = "bdPrintRoot";
      document.body.appendChild(root);
    }
    root.innerHTML = html;
    setTimeout(function () {
      window.print();
    }, 50);
  }

  function utf8ToBase64(str) {
    const bytes = new TextEncoder().encode(str);
    let bin = "";
    bytes.forEach(function (b) { bin += String.fromCharCode(b); });
    return btoa(bin);
  }

  async function uploadHtmlToDropbox(folder, filename, html) {
    if (!window.dbxUploadBase64) throw new Error("Dropbox未接続");
    const wrapped =
      "<!DOCTYPE html><html lang=\"ja\"><head><meta charset=\"UTF-8\"><title>" +
      esc(filename) +
      "</title><style>body{font-family:serif;padding:24px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:8px}.num{text-align:right}</style></head><body>" +
      html +
      "</body></html>";
    const path = (folder.replace(/\/$/, "") + "/" + filename).replace(/\/+/g, "/");
    return window.dbxUploadBase64(path, utf8ToBase64(wrapped), { mode: "add" });
  }

  /* ---------- 請求・見積 ---------- */
  function invoiceState() {
    return {
      docType: "invoice",
      client: "",
      title: "",
      date: today(),
      due: "",
      note: "",
      items: [{ name: "", qty: 1, unit: 0 }],
      subCost: 0,
      subNote: "",
      prezApproved: false,
      localSaved: false,
      dropboxSaved: false,
      dropboxPath: "",
      id: "",
    };
  }

  let INV = invoiceState();

  function sellTotal() {
    return INV.items.reduce(function (s, it) {
      return s + (Number(it.qty) || 0) * (Number(it.unit) || 0);
    }, 0);
  }

  function renderInvoiceSheet() {
    const sell = sellTotal();
    const mi = marginInfo(sell, INV.subCost);
    const rows = INV.items
      .filter(function (it) { return it.name || it.unit; })
      .map(function (it) {
        const line = (Number(it.qty) || 0) * (Number(it.unit) || 0);
        return (
          "<tr><td>" +
          esc(it.name || "—") +
          "</td><td class=\"num\">" +
          esc(it.qty) +
          "</td><td class=\"num\">" +
          yen(it.unit) +
          "</td><td class=\"num\">" +
          yen(line) +
          "</td></tr>"
        );
      })
      .join("");
    const label = INV.docType === "estimate" ? "御見積書" : "請求書";
    return (
      '<div class="bd-sheet" id="bdInvoiceSheet">' +
      '<p class="bd-co">GOONER</p>' +
      '<div class="bd-meta">発行日 ' +
      esc(INV.date) +
      (INV.due ? " ／ お支払期限 " + esc(INV.due) : "") +
      "</div>" +
      "<h4>" +
      label +
      "</h4>" +
      "<p><b>御中：</b>" +
      esc(INV.client || "（取引先）") +
      "</p>" +
      (INV.title ? "<p><b>件名：</b>" + esc(INV.title) + "</p>" : "") +
      "<table><thead><tr><th>品目</th><th>数量</th><th>単価</th><th>金額</th></tr></thead><tbody>" +
      (rows || "<tr><td colspan=\"4\">（明細なし）</td></tr>") +
      "</tbody></table>" +
      '<div class="bd-total">合計（税込想定） ' +
      yen(sell) +
      "</div>" +
      (INV.note ? "<p style=\"margin-top:16px;font-size:12px\">備考：" + esc(INV.note) + "</p>" : "") +
      '<div class="bd-stamp"><div class="bd-box">担当</div><div class="bd-box">確認</div><div class="bd-box">社長</div></div>' +
      (mi.rate != null
        ? '<p style="margin-top:18px;font-size:11px;color:#666">社内控：原価 ' +
          yen(INV.subCost) +
          " ／ 利益率 " +
          (mi.rate * 100).toFixed(1) +
          "%" +
          (mi.ok ? "" : " 【社長決裁対象】") +
          "</p>"
        : "") +
      "</div>"
    );
  }

  function renderInvoiceApp() {
    const root = document.getElementById("billingInvoiceApp");
    if (!root) return;
    injectStyles();
    const sell = sellTotal();
    const mi = marginInfo(sell, INV.subCost);
    const needPrez = INV.docType === "invoice" && mi.rate != null && !mi.ok;
    const hist = load(LS_INV);

    let alertHtml = "";
    if (needPrez && !INV.prezApproved) {
      alertHtml =
        '<div class="bd-alert bad"><b>社長決裁アラート</b><br>利益率が最低基準25%を下回っています（現在 ' +
        (mi.rate * 100).toFixed(1) +
        "%）。請求書の確定・Dropbox保管の前に社長決裁が必要です。</div>";
    } else if (needPrez && INV.prezApproved) {
      alertHtml = '<div class="bd-alert ok">社長決裁済み（利益率 ' + (mi.rate * 100).toFixed(1) + "%）</div>";
    } else if (mi.rate != null) {
      alertHtml =
        '<div class="bd-alert ok">利益率 ' +
        (mi.rate * 100).toFixed(1) +
        "%（基準25%以上）／ 粗利 " +
        yen(mi.profit) +
        "</div>";
    }

    const itemRows = INV.items
      .map(function (it, i) {
        return (
          '<div class="bd-item-row" data-i="' +
          i +
          '">' +
          '<div class="bd-field"><label>品目</label><input data-f="name" value="' +
          esc(it.name) +
          '"></div>' +
          '<div class="bd-field"><label>数量</label><input data-f="qty" type="number" min="0" step="1" value="' +
          esc(it.qty) +
          '"></div>' +
          '<div class="bd-field"><label>単価</label><input data-f="unit" type="number" min="0" step="1" value="' +
          esc(it.unit) +
          '"></div>' +
          '<button type="button" class="bd-mini secondary" data-rm="' +
          i +
          '">削除</button></div>'
        );
      })
      .join("");

    root.innerHTML =
      '<div class="bd-grid">' +
      '<div class="bd-card">' +
      "<h3>作成</h3>" +
      '<div class="bd-row">' +
      '<div class="bd-field"><label>書類種別</label><select id="bdDocType"><option value="invoice"' +
      (INV.docType === "invoice" ? " selected" : "") +
      ">請求書</option><option value=\"estimate\"" +
      (INV.docType === "estimate" ? " selected" : "") +
      ">見積書</option></select></div>" +
      '<div class="bd-field"><label>発行日</label><input id="bdDate" type="date" value="' +
      esc(INV.date) +
      '"></div></div>' +
      '<div class="bd-row"><div class="bd-field"><label>取引先</label><input id="bdClient" value="' +
      esc(INV.client) +
      '" placeholder="株式会社◯◯ 御中"></div>' +
      '<div class="bd-field"><label>お支払期限</label><input id="bdDue" type="date" value="' +
      esc(INV.due) +
      '"></div></div>' +
      '<div class="bd-row full"><div class="bd-field"><label>件名</label><input id="bdTitle" value="' +
      esc(INV.title) +
      '"></div></div>' +
      '<div class="bd-items" id="bdItems">' +
      itemRows +
      "</div>" +
      '<button type="button" class="bd-mini secondary" id="bdAddItem">＋ 明細行</button>' +
      '<div class="bd-row" style="margin-top:12px">' +
      '<div class="bd-field"><label>下請け原価合計</label><input id="bdSubCost" type="number" min="0" step="1" value="' +
      esc(INV.subCost) +
      '"></div>' +
      '<div class="bd-field"><label>販売合計（自動）</label><input readonly value="' +
      esc(sell) +
      '"></div></div>' +
      '<div class="bd-field" style="margin-top:8px"><label>下請け見積メモ／貼り付けテキスト</label>' +
      '<textarea id="bdSubText" rows="4" placeholder="下請け見積の金額行を貼り付け、または下でPDFを選択">' +
      esc(INV.subNote) +
      "</textarea></div>" +
      '<div class="bd-actions">' +
      '<button type="button" id="bdParseText">テキストから原価計算</button>' +
      '<label class="bd-mini secondary" style="display:inline-flex;align-items:center;gap:6px;cursor:pointer">PDF取込<input type="file" id="bdPdf" accept="application/pdf,.pdf" hidden></label>' +
      "</div>" +
      alertHtml +
      (needPrez && !INV.prezApproved && isPresident()
        ? '<div class="bd-actions"><button type="button" class="warn" id="bdPrezOk">社長決裁する</button></div>'
        : "") +
      '<div class="bd-field" style="margin-top:8px"><label>備考</label><textarea id="bdNote" rows="2">' +
      esc(INV.note) +
      "</textarea></div>" +
      '<div class="bd-actions">' +
      '<button type="button" id="bdSaveLocal">保管（ローカル）</button>' +
      '<button type="button" id="bdPrint">印刷（コピー機／プリンタ）</button>' +
      '<button type="button" id="bdDropbox">Dropboxへ保管</button>' +
      '<button type="button" class="secondary" id="bdNew">新規作成</button>' +
      "</div>" +
      '<div class="bd-check"><b>保管確認</b><ul>' +
      "<li>ローカル保管：" +
      (INV.localSaved ? "✓ 済" : "未") +
      "</li>" +
      "<li>Dropbox保管（" +
      esc(DBX_INV) +
      "）：" +
      (INV.dropboxSaved ? "✓ 済 " + esc(INV.dropboxPath) : "未 — 作成後は必ずDropboxへ保管してください") +
      "</li></ul></div>" +
      '<div style="margin-top:14px"><h3>保管一覧</h3><div class="bd-hist" id="bdHist">' +
      (hist.length
        ? hist
            .map(function (h) {
              return (
                "<div>" +
                esc(h.date) +
                " " +
                esc(h.docType === "estimate" ? "見積" : "請求") +
                " " +
                esc(h.client) +
                " " +
                yen(h.sell) +
                (h.dropboxSaved ? " · DB✓" : " · DB未") +
                ' <button type="button" class="bd-mini secondary" data-load="' +
                esc(h.id) +
                '">開く</button></div>'
              );
            })
            .join("")
        : "<div class=\"bd-alert\">まだ保管がありません</div>") +
      "</div></div></div>" +
      '<div class="bd-card"><h3>プレビュー</h3>' +
      renderInvoiceSheet() +
      "</div></div>";

    wireInvoice(root);
  }

  function readInvoiceForm(root) {
    INV.docType = root.querySelector("#bdDocType")?.value || "invoice";
    INV.date = root.querySelector("#bdDate")?.value || today();
    INV.client = root.querySelector("#bdClient")?.value || "";
    INV.due = root.querySelector("#bdDue")?.value || "";
    INV.title = root.querySelector("#bdTitle")?.value || "";
    INV.subCost = Number(root.querySelector("#bdSubCost")?.value || 0);
    INV.subNote = root.querySelector("#bdSubText")?.value || "";
    INV.note = root.querySelector("#bdNote")?.value || "";
    INV.items = Array.from(root.querySelectorAll("#bdItems .bd-item-row")).map(function (row) {
      return {
        name: row.querySelector('[data-f="name"]')?.value || "",
        qty: Number(row.querySelector('[data-f="qty"]')?.value || 0),
        unit: Number(row.querySelector('[data-f="unit"]')?.value || 0),
      };
    });
    if (!INV.items.length) INV.items = [{ name: "", qty: 1, unit: 0 }];
  }

  function canFinalizeInvoice() {
    const sell = sellTotal();
    const mi = marginInfo(sell, INV.subCost);
    if (INV.docType === "invoice" && mi.rate != null && !mi.ok && !INV.prezApproved) {
      toast("利益率25%未満のため社長決裁が必要です");
      return false;
    }
    return true;
  }

  function wireInvoice(root) {
    const refresh = function () {
      readInvoiceForm(root);
      renderInvoiceApp();
    };
    root.querySelector("#bdDocType")?.addEventListener("change", refresh);
    ["bdDate", "bdClient", "bdDue", "bdTitle", "bdSubCost", "bdSubText", "bdNote"].forEach(function (id) {
      root.querySelector("#" + id)?.addEventListener("change", refresh);
    });
    root.querySelector("#bdItems")?.addEventListener("change", refresh);
    root.querySelector("#bdAddItem")?.addEventListener("click", function () {
      readInvoiceForm(root);
      INV.items.push({ name: "", qty: 1, unit: 0 });
      renderInvoiceApp();
    });
    root.querySelectorAll("[data-rm]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        readInvoiceForm(root);
        const i = Number(btn.getAttribute("data-rm"));
        INV.items.splice(i, 1);
        if (!INV.items.length) INV.items.push({ name: "", qty: 1, unit: 0 });
        renderInvoiceApp();
      });
    });
    root.querySelector("#bdParseText")?.addEventListener("click", function () {
      readInvoiceForm(root);
      const parsed = parseMoneyFromText(INV.subNote);
      if (!parsed.cost) {
        toast("金額を読み取れませんでした。テキストを貼り付けてください");
        return;
      }
      INV.subCost = parsed.cost;
      if (parsed.lines.length) {
        INV.subNote =
          INV.subNote +
          "\n--- 抽出 ---\n" +
          parsed.lines.map(function (l) { return l.name + " " + l.unit; }).join("\n");
      }
      toast("下請け原価を自動計算しました: " + yen(parsed.cost));
      renderInvoiceApp();
    });
    root.querySelector("#bdPdf")?.addEventListener("change", async function (ev) {
      const file = (ev.target.files || [])[0];
      ev.target.value = "";
      if (!file) return;
      try {
        toast("PDFを解析中…");
        const text = await extractPdfText(file);
        readInvoiceForm(root);
        INV.subNote = (INV.subNote ? INV.subNote + "\n" : "") + text.slice(0, 8000);
        const parsed = parseMoneyFromText(text);
        if (parsed.cost) INV.subCost = parsed.cost;
        toast(parsed.cost ? "PDFから原価 " + yen(parsed.cost) + " を取り込みました" : "PDFテキストを取り込みました（金額は手入力）");
        renderInvoiceApp();
      } catch (e) {
        toast("PDF取込失敗: " + (e.message || e));
      }
    });
    root.querySelector("#bdPrezOk")?.addEventListener("click", function () {
      if (!isPresident()) {
        toast("社長のみ決裁できます");
        return;
      }
      if (!confirm("利益率25%未満の請求書を社長決裁しますか？")) return;
      readInvoiceForm(root);
      INV.prezApproved = true;
      toast("社長決裁を記録しました");
      renderInvoiceApp();
    });
    root.querySelector("#bdPrint")?.addEventListener("click", function () {
      readInvoiceForm(root);
      if (!canFinalizeInvoice()) return;
      printSheet(renderInvoiceSheet());
      toast("印刷ダイアログを開きました（コピー機／プリンタを選択）");
    });
    root.querySelector("#bdSaveLocal")?.addEventListener("click", function () {
      readInvoiceForm(root);
      if (!INV.client) {
        toast("取引先を入力してください");
        return;
      }
      if (!canFinalizeInvoice()) return;
      if (!INV.id) INV.id = uid("INV");
      const sell = sellTotal();
      const arr = load(LS_INV).filter(function (x) { return x.id !== INV.id; });
      const rec = {
        id: INV.id,
        docType: INV.docType,
        client: INV.client,
        title: INV.title,
        date: INV.date,
        due: INV.due,
        note: INV.note,
        items: INV.items,
        subCost: INV.subCost,
        subNote: INV.subNote,
        prezApproved: INV.prezApproved,
        sell: sell,
        localSaved: true,
        dropboxSaved: INV.dropboxSaved,
        dropboxPath: INV.dropboxPath,
        by: who(),
        at: new Date().toISOString(),
      };
      arr.unshift(rec);
      save(LS_INV, arr);
      INV.localSaved = true;
      toast("ローカルに保管しました。続けてDropboxへも保管してください");
      renderInvoiceApp();
    });
    root.querySelector("#bdDropbox")?.addEventListener("click", async function () {
      readInvoiceForm(root);
      if (!canFinalizeInvoice()) return;
      if (!INV.localSaved) {
        if (!confirm("まだローカル保管が未です。先にローカル保管してからDropboxへ進めますか？")) return;
        root.querySelector("#bdSaveLocal")?.click();
      }
      if (!confirm("作成した請求／見積を Dropbox の " + DBX_INV + " に保管しますか？\n保管後、保管有無の確認欄が更新されます。")) return;
      try {
        if (!INV.id) INV.id = uid("INV");
        const name =
          (INV.docType === "estimate" ? "見積_" : "請求_") +
          (INV.date || today()) +
          "_" +
          (INV.client || "取引先").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) +
          ".html";
        const res = await uploadHtmlToDropbox(DBX_INV, name, document.getElementById("bdInvoiceSheet")?.innerHTML || renderInvoiceSheet());
        INV.dropboxSaved = true;
        INV.dropboxPath = res.path || DBX_INV + "/" + name;
        INV.localSaved = true;
        const arr = load(LS_INV);
        const i = arr.findIndex(function (x) { return x.id === INV.id; });
        const sell = sellTotal();
        const rec = Object.assign({}, INV, { sell: sell, by: who(), at: new Date().toISOString() });
        if (i >= 0) arr[i] = rec;
        else arr.unshift(rec);
        save(LS_INV, arr);
        toast("Dropboxへ保管しました: " + INV.dropboxPath);
        renderInvoiceApp();
      } catch (e) {
        toast("Dropbox保管失敗: " + (e.message || e) + "（ログインとDropbox許可を確認）");
      }
    });
    root.querySelector("#bdNew")?.addEventListener("click", function () {
      INV = invoiceState();
      renderInvoiceApp();
    });
    root.querySelectorAll("[data-load]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const id = btn.getAttribute("data-load");
        const h = load(LS_INV).find(function (x) { return x.id === id; });
        if (!h) return;
        INV = Object.assign(invoiceState(), h);
        renderInvoiceApp();
      });
    });
  }

  /* ---------- 領収書 ---------- */
  let RCP = {
    id: "",
    date: today(),
    payee: "",
    amount: 0,
    forWhat: "",
    method: "現金",
    note: "",
    localSaved: false,
    dropboxSaved: false,
    dropboxPath: "",
  };

  function renderReceiptSheet() {
    return (
      '<div class="bd-sheet" id="bdReceiptSheet">' +
      '<p class="bd-co">GOONER</p>' +
      '<div class="bd-meta">発行日 ' +
      esc(RCP.date) +
      "</div>" +
      "<h4>領　収　書</h4>" +
      "<p style=\"font-size:18px;margin:18px 0\"><b>" +
      esc(RCP.payee || "（宛名）") +
      "</b> 様</p>" +
      '<p style="font-size:28px;font-weight:800;text-align:center;margin:24px 0;border-bottom:2px solid #222;padding-bottom:10px">' +
      yen(RCP.amount) +
      "</p>" +
      "<p>但し　" +
      esc(RCP.forWhat || "（但し書き）") +
      "　として正に領収いたしました。</p>" +
      "<p style=\"margin-top:12px\">お支払方法：" +
      esc(RCP.method) +
      "</p>" +
      (RCP.note ? "<p style=\"margin-top:8px;font-size:12px\">備考：" + esc(RCP.note) + "</p>" : "") +
      '<div class="bd-stamp"><div class="bd-box">収入印紙</div><div class="bd-box">社印</div></div>' +
      "</div>"
    );
  }

  function renderReceiptApp() {
    const root = document.getElementById("billingReceiptApp");
    if (!root) return;
    injectStyles();
    const hist = load(LS_RCP);
    root.innerHTML =
      '<div class="bd-grid"><div class="bd-card"><h3>作成</h3>' +
      '<div class="bd-row"><div class="bd-field"><label>発行日</label><input id="rcDate" type="date" value="' +
      esc(RCP.date) +
      '"></div>' +
      '<div class="bd-field"><label>お支払方法</label><select id="rcMethod"><option' +
      (RCP.method === "現金" ? " selected" : "") +
      ">現金</option><option" +
      (RCP.method === "振込" ? " selected" : "") +
      ">振込</option><option" +
      (RCP.method === "その他" ? " selected" : "") +
      ">その他</option></select></div></div>" +
      '<div class="bd-row full"><div class="bd-field"><label>宛名</label><input id="rcPayee" value="' +
      esc(RCP.payee) +
      '" placeholder="◯◯ 様"></div></div>' +
      '<div class="bd-row"><div class="bd-field"><label>金額</label><input id="rcAmt" type="number" min="0" step="1" value="' +
      esc(RCP.amount) +
      '"></div>' +
      '<div class="bd-field"><label>但し書き</label><input id="rcFor" value="' +
      esc(RCP.forWhat) +
      '" placeholder="御請求書代金として"></div></div>' +
      '<div class="bd-field"><label>備考</label><textarea id="rcNote" rows="2">' +
      esc(RCP.note) +
      "</textarea></div>" +
      '<div class="bd-actions"><button type="button" id="rcSave">保管（ローカル）</button>' +
      '<button type="button" id="rcPrint">印刷（コピー機／プリンタ）</button>' +
      '<button type="button" id="rcDropbox">Dropboxへ保管</button>' +
      '<button type="button" class="secondary" id="rcNew">新規</button></div>' +
      '<div class="bd-check"><b>保管確認</b><ul>' +
      "<li>ローカル保管：" +
      (RCP.localSaved ? "✓ 済" : "未") +
      "</li>" +
      "<li>Dropbox保管（" +
      esc(DBX_RCP) +
      "）：" +
      (RCP.dropboxSaved ? "✓ 済 " + esc(RCP.dropboxPath) : "未 — 作成後は必ずDropboxへ保管してください") +
      "</li></ul></div>" +
      '<div style="margin-top:14px"><h3>保管一覧</h3><div class="bd-hist">' +
      (hist.length
        ? hist
            .map(function (h) {
              return (
                "<div>" +
                esc(h.date) +
                " " +
                esc(h.payee) +
                " " +
                yen(h.amount) +
                (h.dropboxSaved ? " · DB✓" : " · DB未") +
                ' <button type="button" class="bd-mini secondary" data-rload="' +
                esc(h.id) +
                '">開く</button></div>'
              );
            })
            .join("")
        : "<div class=\"bd-alert\">まだ保管がありません</div>") +
      "</div></div>" +
      '<div class="bd-card"><h3>プレビュー</h3>' +
      renderReceiptSheet() +
      "</div></div>";

    const read = function () {
      RCP.date = root.querySelector("#rcDate")?.value || today();
      RCP.method = root.querySelector("#rcMethod")?.value || "現金";
      RCP.payee = root.querySelector("#rcPayee")?.value || "";
      RCP.amount = Number(root.querySelector("#rcAmt")?.value || 0);
      RCP.forWhat = root.querySelector("#rcFor")?.value || "";
      RCP.note = root.querySelector("#rcNote")?.value || "";
    };
    ["rcDate", "rcMethod", "rcPayee", "rcAmt", "rcFor", "rcNote"].forEach(function (id) {
      root.querySelector("#" + id)?.addEventListener("change", function () {
        read();
        renderReceiptApp();
      });
    });
    root.querySelector("#rcPrint")?.addEventListener("click", function () {
      read();
      printSheet(renderReceiptSheet());
      toast("印刷ダイアログを開きました（コピー機／プリンタを選択）");
    });
    root.querySelector("#rcSave")?.addEventListener("click", function () {
      read();
      if (!RCP.payee || !RCP.amount) {
        toast("宛名と金額を入力してください");
        return;
      }
      if (!RCP.id) RCP.id = uid("RCP");
      RCP.localSaved = true;
      const arr = load(LS_RCP).filter(function (x) { return x.id !== RCP.id; });
      arr.unshift(Object.assign({}, RCP, { by: who(), at: new Date().toISOString() }));
      save(LS_RCP, arr);
      toast("ローカルに保管しました。続けてDropboxへも保管してください");
      renderReceiptApp();
    });
    root.querySelector("#rcDropbox")?.addEventListener("click", async function () {
      read();
      if (!RCP.localSaved) root.querySelector("#rcSave")?.click();
      if (!confirm("領収書を Dropbox の " + DBX_RCP + " に保管しますか？")) return;
      try {
        if (!RCP.id) RCP.id = uid("RCP");
        const name =
          "領収_" +
          (RCP.date || today()) +
          "_" +
          (RCP.payee || "宛名").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) +
          ".html";
        const res = await uploadHtmlToDropbox(DBX_RCP, name, document.getElementById("bdReceiptSheet")?.innerHTML || renderReceiptSheet());
        RCP.dropboxSaved = true;
        RCP.dropboxPath = res.path || DBX_RCP + "/" + name;
        RCP.localSaved = true;
        const arr = load(LS_RCP);
        const i = arr.findIndex(function (x) { return x.id === RCP.id; });
        const rec = Object.assign({}, RCP, { by: who(), at: new Date().toISOString() });
        if (i >= 0) arr[i] = rec;
        else arr.unshift(rec);
        save(LS_RCP, arr);
        toast("Dropboxへ保管しました: " + RCP.dropboxPath);
        renderReceiptApp();
      } catch (e) {
        toast("Dropbox保管失敗: " + (e.message || e));
      }
    });
    root.querySelector("#rcNew")?.addEventListener("click", function () {
      RCP = {
        id: "",
        date: today(),
        payee: "",
        amount: 0,
        forWhat: "",
        method: "現金",
        note: "",
        localSaved: false,
        dropboxSaved: false,
        dropboxPath: "",
      };
      renderReceiptApp();
    });
    root.querySelectorAll("[data-rload]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const h = load(LS_RCP).find(function (x) { return x.id === btn.getAttribute("data-rload"); });
        if (!h) return;
        RCP = Object.assign({}, h);
        renderReceiptApp();
      });
    });
  }

  function boot() {
    injectStyles();
    renderInvoiceApp();
    renderReceiptApp();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot);
  else boot();

  document.querySelectorAll('.gamenav button[data-s="billing-invoice"], .gamenav button[data-s="billing-receipt"]').forEach(function (b) {
    b.addEventListener("click", function () {
      setTimeout(function () {
        if (b.dataset.s === "billing-invoice") renderInvoiceApp();
        else renderReceiptApp();
      }, 30);
    });
  });

  window.BillingDocs = { renderInvoiceApp: renderInvoiceApp, renderReceiptApp: renderReceiptApp, MIN_MARGIN: MIN_MARGIN };
})();
