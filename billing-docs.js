/* 請求書・見積書・領収書（試作テンプレート） */
(function () {
  const MIN_MARGIN = 0.25;
  const LS_INV = "gp_billing_invoices_v1";
  const LS_RCP = "gp_billing_receipts_v1";
  const DBX_INV = "/GoonerPortal/請求書";
  const DBX_RCP = "/GoonerPortal/領収書";
  const TAX_RATE = 0.1;

  /** 発行元（試作・後で正式情報に差し替え可） */
  const ISSUER = {
    name: "株式会社Gooner",
    brand: "GOONER",
    tagline: "For the Should Be",
    rep: "代表取締役　深山　弘次",
    zip: "〒000-0000",
    addr: "（試作）本社所在地は正式登録後に表示",
    tel: "TEL （試作）000-0000-0000",
    email: "billing@gooner.example",
    invoiceReg: "登録番号　T0000000000000（試作）",
    bank: {
      name: "〇〇銀行　〇〇支店",
      type: "普通",
      number: "1234567",
      holder: "カ）グーナー",
    },
  };

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
  function addDays(iso, days) {
    const d = new Date(String(iso || today()) + "T12:00:00");
    if (isNaN(d.getTime())) return today();
    d.setDate(d.getDate() + (days || 0));
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }
  function fmtDate(iso) {
    const m = String(iso || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return esc(iso || "");
    return m[1] + "年" + Number(m[2]) + "月" + Number(m[3]) + "日";
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
  function docNo(prefix, dateIso) {
    const d = String(dateIso || today()).replace(/-/g, "");
    return prefix + "-" + d + "-" + String(Math.floor(Math.random() * 900) + 100);
  }

  function injectStyles() {
    if (document.getElementById("billingDocsCss")) return;
    const st = document.createElement("style");
    st.id = "billingDocsCss";
    st.textContent = `
#billingInvoiceApp,#billingReceiptApp{color:var(--text)}
.bd-grid{display:grid;grid-template-columns:minmax(0,1.05fr) minmax(0,.95fr);gap:14px}
@media(max-width:980px){.bd-grid{grid-template-columns:1fr}}
.bd-card{background:var(--panel,#111);border:1px solid var(--line,rgba(255,255,255,.2));border-radius:12px;padding:14px}
.bd-card h3{margin:0 0 10px;font-size:14px}
.bd-proto{display:inline-block;margin-left:8px;padding:2px 8px;border-radius:999px;font-size:10px;font-weight:800;letter-spacing:.06em;background:rgba(210,173,99,.2);color:#e7cd84;vertical-align:middle}
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
.bd-alert{margin:10px 0;padding:12px 14px;border-radius:10px;border-left:4px solid #e0a040;background:rgba(224,160,64,.12);color:#f0c878;font-size:13px;line-height:1.55}
.bd-alert.ok{border-left-color:#33c6b3;background:rgba(51,198,179,.1);color:#9fe8dc}
.bd-alert.bad{border-left-color:#e07070;background:rgba(224,80,80,.12);color:#ffc0c0}
.bd-sheet{
  background:#fff;color:#1a1a1a;border-radius:6px;padding:0;overflow:hidden;
  font-family:"Hiragino Sans","Noto Sans JP","Yu Gothic",sans-serif;
  box-shadow:0 8px 28px rgba(0,0,0,.35);min-height:520px
}
.bd-sheet-inner{padding:28px 30px 32px}
.bd-ribbon{background:#0d1412;color:#9fe8dc;font-size:10px;letter-spacing:.14em;font-weight:800;padding:6px 14px;text-align:center}
.bd-head{display:flex;justify-content:space-between;gap:16px;align-items:flex-start;margin-bottom:18px}
.bd-head-left .bd-co{font-size:22px;font-weight:800;letter-spacing:.12em;margin:0;color:#0d1412}
.bd-head-left .bd-tag{font-size:11px;color:#667;margin:2px 0 0}
.bd-doc-title{margin:0;font-size:26px;font-weight:800;letter-spacing:.2em;text-align:right;border-bottom:3px solid #1a1a1a;padding-bottom:6px}
.bd-doc-sub{text-align:right;font-size:11px;color:#666;margin-top:6px;line-height:1.5}
.bd-parties{display:grid;grid-template-columns:1.1fr .9fr;gap:18px;margin:18px 0}
.bd-client{font-size:16px;font-weight:700;border-bottom:1px solid #222;padding-bottom:6px;margin-bottom:8px}
.bd-client small{display:block;font-size:11px;font-weight:500;color:#666;margin-top:4px}
.bd-issuer{font-size:11px;line-height:1.65;color:#333;text-align:right}
.bd-issuer b{display:block;font-size:13px;margin-bottom:4px}
.bd-summary{display:flex;justify-content:flex-end;margin:10px 0 16px}
.bd-summary-box{min-width:240px;border:2px solid #1a1a1a;padding:10px 14px;background:#f7faf8}
.bd-summary-box .lab{font-size:11px;color:#555}
.bd-summary-box .val{font-size:22px;font-weight:800;letter-spacing:.02em;margin-top:2px}
.bd-sheet table{width:100%;border-collapse:collapse;font-size:12px;margin:8px 0 12px}
.bd-sheet th,.bd-sheet td{border:1px solid #b8b8b8;padding:8px 9px;text-align:left;vertical-align:top}
.bd-sheet th{background:#eef2f0;font-weight:700}
.bd-sheet .num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}
.bd-totals{width:280px;margin-left:auto;font-size:12px}
.bd-totals tr td{border:none;padding:4px 0}
.bd-totals .grand td{border-top:2px solid #1a1a1a;padding-top:8px;font-size:14px;font-weight:800}
.bd-notes{margin-top:16px;font-size:11px;line-height:1.65;color:#333;border-top:1px dashed #ccc;padding-top:12px}
.bd-notes h5{margin:0 0 6px;font-size:12px}
.bd-bank{background:#f5f7f6;border:1px solid #d0d6d3;border-radius:6px;padding:10px 12px;margin-top:8px}
.bd-stamp{margin-top:22px;display:flex;justify-content:flex-end;gap:16px}
.bd-box{width:84px;height:84px;border:1px solid #888;display:flex;align-items:flex-start;justify-content:center;padding-top:8px;font-size:11px;color:#666}
.bd-foot{margin-top:18px;font-size:10px;color:#888;text-align:center}
.bd-check{margin-top:12px;padding:12px;border:1px dashed rgba(255,255,255,.3);border-radius:10px;font-size:12px}
.bd-check li{margin:6px 0}
.bd-hist{max-height:220px;overflow:auto;font-size:12px}
.bd-hist button{margin-left:8px}
.bd-items .bd-item-row{display:grid;grid-template-columns:1.4fr .55fr .55fr auto;gap:6px;margin-bottom:6px;align-items:end}
@media print{
  body *{visibility:hidden!important}
  #bdPrintRoot,#bdPrintRoot *{visibility:visible!important}
  #bdPrintRoot{position:absolute;left:0;top:0;width:100%;background:#fff;padding:12px}
  .bd-ribbon{display:none!important}
  .bd-sheet{box-shadow:none!important}
}
`;
    document.head.appendChild(st);
  }

  function taxBreak(gross) {
    const total = Math.round(Number(gross) || 0);
    const net = Math.round(total / (1 + TAX_RATE));
    const tax = total - net;
    return { total: total, net: net, tax: tax };
  }

  function marginInfo(sell, cost) {
    sell = Number(sell) || 0;
    cost = Number(cost) || 0;
    if (sell <= 0) return { rate: null, ok: true, profit: sell - cost };
    const profit = sell - cost;
    const rate = profit / sell;
    return { rate: rate, ok: rate >= MIN_MARGIN, profit: profit };
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
    amounts.sort(function (a, b) { return b - a; });
    return { cost: amounts[0] || 0, rawHits: amounts.slice(0, 8) };
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

  function printSheet(html) {
    let root = document.getElementById("bdPrintRoot");
    if (!root) {
      root = document.createElement("div");
      root.id = "bdPrintRoot";
      document.body.appendChild(root);
    }
    root.innerHTML = html;
    setTimeout(function () { window.print(); }, 50);
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
      "</title><style>body{font-family:sans-serif;padding:16px;background:#fff;color:#111}table{border-collapse:collapse;width:100%}td,th{border:1px solid #999;padding:8px}.num{text-align:right}</style></head><body>" +
      html +
      "</body></html>";
    const path = (folder.replace(/\/$/, "") + "/" + filename).replace(/\/+/g, "/");
    return window.dbxUploadBase64(path, utf8ToBase64(wrapped), { mode: "add" });
  }

  function issuerBlock() {
    return (
      '<div class="bd-issuer"><b>' +
      esc(ISSUER.name) +
      "</b>" +
      esc(ISSUER.rep) +
      "<br>" +
      esc(ISSUER.zip) +
      "　" +
      esc(ISSUER.addr) +
      "<br>" +
      esc(ISSUER.tel) +
      "<br>" +
      esc(ISSUER.invoiceReg) +
      "</div>"
    );
  }

  /* ---------- サンプル ---------- */
  function sampleInvoice() {
    const d = today();
    return {
      docType: "invoice",
      no: docNo("INV", d),
      client: "株式会社サンプル商事",
      clientHonor: "御中",
      title: "パラダイスシティ関連　出演手配業務（試作）",
      date: d,
      due: addDays(d, 30),
      note: "お振込手数料は貴社負担にてお願いいたします。\n本書類はポータル試作テンプレートです。正式運用前に文言・口座を確定してください。",
      items: [
        { name: "出演手配フィー（仲介）", qty: 1, unit: 880000 },
        { name: "渡航・現地調整サポート", qty: 1, unit: 110000 },
        { name: "事務手数料", qty: 1, unit: 22000 },
      ],
      subCost: 650000,
      subNote: "下請け見積（試作）\n紹介者・事務所支払 合計 650,000円",
      prezApproved: false,
      localSaved: false,
      dropboxSaved: false,
      dropboxPath: "",
      id: "",
    };
  }

  function sampleEstimate() {
    const d = today();
    return {
      docType: "estimate",
      no: docNo("EST", d),
      client: "ワールドパーク株式会社",
      clientHonor: "御中",
      title: "稲毛海浜公園　イベント運営見積（試作）",
      date: d,
      due: addDays(d, 14),
      note: "本見積の有効期限は発行日より14日間です。\n人数・日程変更により金額が変動する場合があります。\n※試作サンプルです。",
      items: [
        { name: "イベント企画・運営一式", qty: 1, unit: 550000 },
        { name: "スタッフ手配（1日）", qty: 4, unit: 18000 },
        { name: "音響・簡易設備レンタル", qty: 1, unit: 88000 },
      ],
      subCost: 280000,
      subNote: "外注見積（試作）280,000円",
      prezApproved: false,
      localSaved: false,
      dropboxSaved: false,
      dropboxPath: "",
      id: "",
    };
  }

  function sampleReceipt() {
    return {
      id: "",
      no: docNo("RCP", today()),
      date: today(),
      payee: "株式会社サンプル商事",
      amount: 1012000,
      forWhat: "御請求書番号 INV 代金として",
      method: "振込",
      note: "上記正に領収いたしました。（試作テンプレート）",
      localSaved: false,
      dropboxSaved: false,
      dropboxPath: "",
    };
  }

  /* ---------- 請求・見積 ---------- */
  function invoiceState() {
    return {
      docType: "invoice",
      no: "",
      client: "",
      clientHonor: "御中",
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

  let INV = sampleInvoice();

  function sellTotal() {
    return INV.items.reduce(function (s, it) {
      return s + (Number(it.qty) || 0) * (Number(it.unit) || 0);
    }, 0);
  }

  function renderInvoiceSheet() {
    const sell = sellTotal();
    const tb = taxBreak(sell);
    const mi = marginInfo(sell, INV.subCost);
    const isEst = INV.docType === "estimate";
    const label = isEst ? "御見積書" : "請求書";
    const no = INV.no || docNo(isEst ? "EST" : "INV", INV.date);
    const rows = INV.items
      .filter(function (it) { return it.name || it.unit; })
      .map(function (it, idx) {
        const line = (Number(it.qty) || 0) * (Number(it.unit) || 0);
        return (
          "<tr><td class=\"num\">" +
          (idx + 1) +
          "</td><td>" +
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

    const bankHtml = isEst
      ? "<p>本見積の有効期限：" +
        fmtDate(INV.due || addDays(INV.date, 14)) +
        "</p><p>ご発注後、正式な請求書を発行いたします。</p>"
      : '<div class="bd-bank"><b>お振込先（試作）</b><br>' +
        esc(ISSUER.bank.name) +
        "　" +
        esc(ISSUER.bank.type) +
        "　" +
        esc(ISSUER.bank.number) +
        "<br>口座名義　" +
        esc(ISSUER.bank.holder) +
        "<br>お支払期限　" +
        fmtDate(INV.due || "") +
        "</div>";

    return (
      '<div class="bd-sheet" id="bdInvoiceSheet">' +
      '<div class="bd-ribbon">PROTOTYPE　試作書類　正式運用前</div>' +
      '<div class="bd-sheet-inner">' +
      '<div class="bd-head">' +
      '<div class="bd-head-left"><p class="bd-co">' +
      esc(ISSUER.brand) +
      '</p><p class="bd-tag">' +
      esc(ISSUER.tagline) +
      "</p></div>" +
      "<div><h4 class=\"bd-doc-title\">" +
      label +
      '</h4><div class="bd-doc-sub">書類番号　' +
      esc(no) +
      "<br>発行日　" +
      fmtDate(INV.date) +
      (INV.due ? "<br>" + (isEst ? "有効期限　" : "お支払期限　") + fmtDate(INV.due) : "") +
      "</div></div></div>" +
      '<div class="bd-parties">' +
      "<div><div class=\"bd-client\">" +
      esc(INV.client || "（取引先名）") +
      "　" +
      esc(INV.clientHonor || "御中") +
      "<small>件名：" +
      esc(INV.title || "（件名未設定）") +
      "</small></div>" +
      "<p style=\"font-size:12px;line-height:1.7;margin:0\">下記の通り" +
      (isEst ? "お見積り" : "ご請求") +
      "申し上げます。</p></div>" +
      issuerBlock() +
      "</div>" +
      '<div class="bd-summary"><div class="bd-summary-box"><div class="lab">' +
      (isEst ? "お見積金額（税込）" : "ご請求金額（税込）") +
      '</div><div class="val">' +
      yen(tb.total) +
      "</div></div></div>" +
      "<table><thead><tr><th style=\"width:40px\">No</th><th>品目・内容</th><th style=\"width:70px\">数量</th><th style=\"width:100px\">単価</th><th style=\"width:110px\">金額</th></tr></thead><tbody>" +
      (rows || '<tr><td colspan="5">（明細なし）</td></tr>') +
      "</tbody></table>" +
      '<table class="bd-totals"><tr><td>小計（税抜）</td><td class="num">' +
      yen(tb.net) +
      "</td></tr><tr><td>消費税（10%）</td><td class=\"num\">" +
      yen(tb.tax) +
      '</td></tr><tr class="grand"><td>合計（税込）</td><td class="num">' +
      yen(tb.total) +
      "</td></tr></table>" +
      '<div class="bd-notes"><h5>' +
      (isEst ? "見積条件・備考" : "お支払・備考") +
      "</h5>" +
      bankHtml +
      (INV.note
        ? "<p style=\"margin-top:8px;white-space:pre-wrap\">" + esc(INV.note) + "</p>"
        : "") +
      (mi.rate != null
        ? '<p style="margin-top:10px;color:#888">【社内控・印刷時は非推奨】原価 ' +
          yen(INV.subCost) +
          " ／ 利益率 " +
          (mi.rate * 100).toFixed(1) +
          "%" +
          (mi.ok ? "" : "　※25%未満・社長決裁対象") +
          "</p>"
        : "") +
      "</div>" +
      '<div class="bd-stamp"><div class="bd-box">担当</div><div class="bd-box">確認</div><div class="bd-box">承認</div></div>' +
      '<p class="bd-foot">' +
      esc(ISSUER.name) +
      "　試作テンプレート　" +
      esc(no) +
      "</p>" +
      "</div></div>"
    );
  }

  function renderInvoiceApp() {
    const root = document.getElementById("billingInvoiceApp");
    if (!root) return;
    injectStyles();
    if (!INV.no) INV.no = docNo(INV.docType === "estimate" ? "EST" : "INV", INV.date);
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
          '<div class="bd-item-row">' +
          '<div class="bd-field"><label>品目</label><input data-f="name" value="' +
          esc(it.name) +
          '"></div>' +
          '<div class="bd-field"><label>数量</label><input data-f="qty" type="number" min="0" step="1" value="' +
          esc(it.qty) +
          '"></div>' +
          '<div class="bd-field"><label>単価（税込）</label><input data-f="unit" type="number" min="0" step="1" value="' +
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
      "<h3>作成 <span class=\"bd-proto\">試作</span></h3>" +
      '<div class="bd-alert">試作テンプレートです。「サンプル読込」で中身付きの見本を表示できます。住所・口座は仮値です。</div>' +
      '<div class="bd-actions" style="margin-top:0">' +
      '<button type="button" id="bdSampleInv">請求サンプル</button>' +
      '<button type="button" id="bdSampleEst">見積サンプル</button>' +
      '<button type="button" class="secondary" id="bdBlank">空の新規</button>' +
      "</div>" +
      '<div class="bd-row" style="margin-top:12px">' +
      '<div class="bd-field"><label>書類種別</label><select id="bdDocType"><option value="invoice"' +
      (INV.docType === "invoice" ? " selected" : "") +
      ">請求書</option><option value=\"estimate\"" +
      (INV.docType === "estimate" ? " selected" : "") +
      ">見積書</option></select></div>" +
      '<div class="bd-field"><label>書類番号</label><input id="bdNo" value="' +
      esc(INV.no) +
      '"></div></div>' +
      '<div class="bd-row">' +
      '<div class="bd-field"><label>発行日</label><input id="bdDate" type="date" value="' +
      esc(INV.date) +
      '"></div>' +
      '<div class="bd-field"><label>' +
      (INV.docType === "estimate" ? "有効期限" : "お支払期限") +
      '</label><input id="bdDue" type="date" value="' +
      esc(INV.due) +
      '"></div></div>' +
      '<div class="bd-row"><div class="bd-field"><label>取引先</label><input id="bdClient" value="' +
      esc(INV.client) +
      '" placeholder="株式会社◯◯"></div>' +
      '<div class="bd-field"><label>敬称</label><input id="bdHonor" value="' +
      esc(INV.clientHonor || "御中") +
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
      '<div class="bd-field"><label>販売合計（税込・自動）</label><input readonly value="' +
      esc(sell) +
      '"></div></div>' +
      '<div class="bd-field" style="margin-top:8px"><label>下請け見積メモ／貼り付け</label>' +
      '<textarea id="bdSubText" rows="3" placeholder="下請け見積の金額行を貼付、またはPDF取込">' +
      esc(INV.subNote) +
      "</textarea></div>" +
      '<div class="bd-actions">' +
      '<button type="button" id="bdParseText">テキストから原価計算</button>' +
      '<label class="bd-mini secondary" style="display:inline-flex;align-items:center;cursor:pointer">PDF取込<input type="file" id="bdPdf" accept="application/pdf,.pdf" hidden></label>' +
      "</div>" +
      alertHtml +
      (needPrez && !INV.prezApproved && isPresident()
        ? '<div class="bd-actions"><button type="button" class="warn" id="bdPrezOk">社長決裁する</button></div>'
        : "") +
      '<div class="bd-field" style="margin-top:8px"><label>備考</label><textarea id="bdNote" rows="3">' +
      esc(INV.note) +
      "</textarea></div>" +
      '<div class="bd-actions">' +
      '<button type="button" id="bdSaveLocal">保管（ローカル）</button>' +
      '<button type="button" id="bdPrint">印刷</button>' +
      '<button type="button" id="bdDropbox">Dropboxへ保管</button>' +
      "</div>" +
      '<div class="bd-check"><b>保管確認</b><ul>' +
      "<li>ローカル保管：" +
      (INV.localSaved ? "✓ 済" : "未") +
      "</li>" +
      "<li>Dropbox保管（" +
      esc(DBX_INV) +
      "）：" +
      (INV.dropboxSaved ? "✓ 済 " + esc(INV.dropboxPath) : "未 — 作成後はDropboxへ保管してください") +
      "</li></ul></div>" +
      '<div style="margin-top:14px"><h3>保管一覧</h3><div class="bd-hist">' +
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
        : '<div class="bd-alert">まだ保管がありません</div>') +
      "</div></div></div>" +
      '<div class="bd-card"><h3>プレビュー</h3>' +
      renderInvoiceSheet() +
      "</div></div>";

    wireInvoice(root);
  }

  function readInvoiceForm(root) {
    INV.docType = root.querySelector("#bdDocType")?.value || "invoice";
    INV.no = root.querySelector("#bdNo")?.value || INV.no;
    INV.date = root.querySelector("#bdDate")?.value || today();
    INV.client = root.querySelector("#bdClient")?.value || "";
    INV.clientHonor = root.querySelector("#bdHonor")?.value || "御中";
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
    root.querySelector("#bdSampleInv")?.addEventListener("click", function () {
      INV = sampleInvoice();
      renderInvoiceApp();
      toast("請求書サンプルを読み込みました");
    });
    root.querySelector("#bdSampleEst")?.addEventListener("click", function () {
      INV = sampleEstimate();
      renderInvoiceApp();
      toast("見積書サンプルを読み込みました");
    });
    root.querySelector("#bdBlank")?.addEventListener("click", function () {
      INV = invoiceState();
      INV.no = docNo("INV", INV.date);
      renderInvoiceApp();
    });
    ["bdDocType", "bdNo", "bdDate", "bdClient", "bdHonor", "bdDue", "bdTitle", "bdSubCost", "bdSubText", "bdNote"].forEach(function (id) {
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
        INV.items.splice(Number(btn.getAttribute("data-rm")), 1);
        if (!INV.items.length) INV.items.push({ name: "", qty: 1, unit: 0 });
        renderInvoiceApp();
      });
    });
    root.querySelector("#bdParseText")?.addEventListener("click", function () {
      readInvoiceForm(root);
      const parsed = parseMoneyFromText(INV.subNote);
      if (!parsed.cost) {
        toast("金額を読み取れませんでした");
        return;
      }
      INV.subCost = parsed.cost;
      toast("下請け原価を自動計算: " + yen(parsed.cost));
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
        toast(parsed.cost ? "PDFから原価 " + yen(parsed.cost) + " を取り込みました" : "PDFテキストを取り込みました");
        renderInvoiceApp();
      } catch (e) {
        toast("PDF取込失敗: " + (e.message || e));
      }
    });
    root.querySelector("#bdPrezOk")?.addEventListener("click", function () {
      if (!isPresident()) return toast("社長のみ決裁できます");
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
      toast("印刷ダイアログを開きました");
    });
    root.querySelector("#bdSaveLocal")?.addEventListener("click", function () {
      readInvoiceForm(root);
      if (!INV.client) return toast("取引先を入力してください");
      if (!canFinalizeInvoice()) return;
      if (!INV.id) INV.id = uid("INV");
      if (!INV.no) INV.no = docNo(INV.docType === "estimate" ? "EST" : "INV", INV.date);
      const sell = sellTotal();
      const arr = load(LS_INV).filter(function (x) { return x.id !== INV.id; });
      const rec = Object.assign({}, INV, {
        sell: sell,
        localSaved: true,
        by: who(),
        at: new Date().toISOString(),
      });
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
        if (!confirm("先にローカル保管してからDropboxへ進めますか？")) return;
        root.querySelector("#bdSaveLocal")?.click();
      }
      if (!confirm("Dropbox の " + DBX_INV + " に保管しますか？")) return;
      try {
        if (!INV.id) INV.id = uid("INV");
        const name =
          (INV.docType === "estimate" ? "見積_" : "請求_") +
          (INV.no || INV.date) +
          "_" +
          (INV.client || "取引先").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) +
          ".html";
        const res = await uploadHtmlToDropbox(
          DBX_INV,
          name,
          document.getElementById("bdInvoiceSheet")?.outerHTML || renderInvoiceSheet()
        );
        INV.dropboxSaved = true;
        INV.dropboxPath = res.path || DBX_INV + "/" + name;
        INV.localSaved = true;
        const arr = load(LS_INV);
        const i = arr.findIndex(function (x) { return x.id === INV.id; });
        const rec = Object.assign({}, INV, { sell: sellTotal(), by: who(), at: new Date().toISOString() });
        if (i >= 0) arr[i] = rec;
        else arr.unshift(rec);
        save(LS_INV, arr);
        toast("Dropboxへ保管しました: " + INV.dropboxPath);
        renderInvoiceApp();
      } catch (e) {
        toast("Dropbox保管失敗: " + (e.message || e));
      }
    });
    root.querySelectorAll("[data-load]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const h = load(LS_INV).find(function (x) { return x.id === btn.getAttribute("data-load"); });
        if (!h) return;
        INV = Object.assign(invoiceState(), h);
        renderInvoiceApp();
      });
    });
  }

  /* ---------- 領収書 ---------- */
  let RCP = sampleReceipt();

  function receiptState() {
    return {
      id: "",
      no: "",
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
  }

  function renderReceiptSheet() {
    const no = RCP.no || docNo("RCP", RCP.date);
    const tb = taxBreak(RCP.amount);
    return (
      '<div class="bd-sheet" id="bdReceiptSheet">' +
      '<div class="bd-ribbon">PROTOTYPE　試作書類　正式運用前</div>' +
      '<div class="bd-sheet-inner">' +
      '<div class="bd-head">' +
      '<div class="bd-head-left"><p class="bd-co">' +
      esc(ISSUER.brand) +
      '</p><p class="bd-tag">' +
      esc(ISSUER.tagline) +
      "</p></div>" +
      '<div><h4 class="bd-doc-title">領　収　書</h4>' +
      '<div class="bd-doc-sub">書類番号　' +
      esc(no) +
      "<br>発行日　" +
      fmtDate(RCP.date) +
      "</div></div></div>" +
      '<div class="bd-parties">' +
      '<div><div class="bd-client" style="font-size:20px">' +
      esc(RCP.payee || "（宛名）") +
      "　様</div>" +
      '<p style="font-size:13px;margin:16px 0 0;line-height:1.8">下記金額を正に領収いたしました。</p></div>' +
      issuerBlock() +
      "</div>" +
      '<div class="bd-summary"><div class="bd-summary-box"><div class="lab">領収金額（税込）</div><div class="val">' +
      yen(RCP.amount) +
      "</div></div></div>" +
      "<table><tbody>" +
      "<tr><th style=\"width:28%\">但し</th><td>" +
      esc(RCP.forWhat || "—") +
      "</td></tr>" +
      "<tr><th>お支払方法</th><td>" +
      esc(RCP.method || "—") +
      "</td></tr>" +
      "<tr><th>内訳（税抜）</th><td class=\"num\">" +
      yen(tb.net) +
      "</td></tr>" +
      "<tr><th>うち消費税（10%）</th><td class=\"num\">" +
      yen(tb.tax) +
      "</td></tr>" +
      "</tbody></table>" +
      (RCP.note
        ? '<div class="bd-notes"><h5>備考</h5><p style="white-space:pre-wrap;margin:0">' +
          esc(RCP.note) +
          "</p></div>"
        : "") +
      '<div class="bd-stamp"><div class="bd-box">収入印紙</div><div class="bd-box">社印</div></div>' +
      '<p class="bd-foot">' +
      esc(ISSUER.name) +
      "　試作テンプレート　" +
      esc(no) +
      "</p>" +
      "</div></div>"
    );
  }

  function renderReceiptApp() {
    const root = document.getElementById("billingReceiptApp");
    if (!root) return;
    injectStyles();
    if (!RCP.no) RCP.no = docNo("RCP", RCP.date);
    const hist = load(LS_RCP);
    root.innerHTML =
      '<div class="bd-grid"><div class="bd-card"><h3>作成 <span class="bd-proto">試作</span></h3>' +
      '<div class="bd-alert">試作テンプレートです。「領収サンプル」で中身付きの見本を表示できます。</div>' +
      '<div class="bd-actions" style="margin-top:0">' +
      '<button type="button" id="rcSample">領収サンプル</button>' +
      '<button type="button" class="secondary" id="rcNew">空の新規</button>' +
      "</div>" +
      '<div class="bd-row" style="margin-top:12px">' +
      '<div class="bd-field"><label>書類番号</label><input id="rcNo" value="' +
      esc(RCP.no) +
      '"></div>' +
      '<div class="bd-field"><label>発行日</label><input id="rcDate" type="date" value="' +
      esc(RCP.date) +
      '"></div></div>' +
      '<div class="bd-row">' +
      '<div class="bd-field"><label>お支払方法</label><select id="rcMethod">' +
      ["現金", "振込", "カード", "その他"]
        .map(function (m) {
          return "<option" + (RCP.method === m ? " selected" : "") + ">" + m + "</option>";
        })
        .join("") +
      "</select></div>" +
      '<div class="bd-field"><label>金額（税込）</label><input id="rcAmt" type="number" min="0" step="1" value="' +
      esc(RCP.amount) +
      '"></div></div>' +
      '<div class="bd-row full"><div class="bd-field"><label>宛名</label><input id="rcPayee" value="' +
      esc(RCP.payee) +
      '" placeholder="◯◯ 様"></div></div>' +
      '<div class="bd-row full"><div class="bd-field"><label>但し書き</label><input id="rcFor" value="' +
      esc(RCP.forWhat) +
      '" placeholder="御請求書代金として"></div></div>' +
      '<div class="bd-field"><label>備考</label><textarea id="rcNote" rows="2">' +
      esc(RCP.note) +
      "</textarea></div>" +
      '<div class="bd-actions"><button type="button" id="rcSave">保管（ローカル）</button>' +
      '<button type="button" id="rcPrint">印刷</button>' +
      '<button type="button" id="rcDropbox">Dropboxへ保管</button></div>' +
      '<div class="bd-check"><b>保管確認</b><ul>' +
      "<li>ローカル保管：" +
      (RCP.localSaved ? "✓ 済" : "未") +
      "</li>" +
      "<li>Dropbox保管（" +
      esc(DBX_RCP) +
      "）：" +
      (RCP.dropboxSaved ? "✓ 済 " + esc(RCP.dropboxPath) : "未 — 作成後はDropboxへ保管してください") +
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
        : '<div class="bd-alert">まだ保管がありません</div>') +
      "</div></div>" +
      '<div class="bd-card"><h3>プレビュー</h3>' +
      renderReceiptSheet() +
      "</div></div>";

    const read = function () {
      RCP.no = root.querySelector("#rcNo")?.value || RCP.no;
      RCP.date = root.querySelector("#rcDate")?.value || today();
      RCP.method = root.querySelector("#rcMethod")?.value || "現金";
      RCP.payee = root.querySelector("#rcPayee")?.value || "";
      RCP.amount = Number(root.querySelector("#rcAmt")?.value || 0);
      RCP.forWhat = root.querySelector("#rcFor")?.value || "";
      RCP.note = root.querySelector("#rcNote")?.value || "";
    };
    root.querySelector("#rcSample")?.addEventListener("click", function () {
      RCP = sampleReceipt();
      renderReceiptApp();
      toast("領収書サンプルを読み込みました");
    });
    root.querySelector("#rcNew")?.addEventListener("click", function () {
      RCP = receiptState();
      RCP.no = docNo("RCP", RCP.date);
      renderReceiptApp();
    });
    ["rcNo", "rcDate", "rcMethod", "rcPayee", "rcAmt", "rcFor", "rcNote"].forEach(function (id) {
      root.querySelector("#" + id)?.addEventListener("change", function () {
        read();
        renderReceiptApp();
      });
    });
    root.querySelector("#rcPrint")?.addEventListener("click", function () {
      read();
      printSheet(renderReceiptSheet());
      toast("印刷ダイアログを開きました");
    });
    root.querySelector("#rcSave")?.addEventListener("click", function () {
      read();
      if (!RCP.payee || !RCP.amount) return toast("宛名と金額を入力してください");
      if (!RCP.id) RCP.id = uid("RCP");
      if (!RCP.no) RCP.no = docNo("RCP", RCP.date);
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
      if (!confirm("Dropbox の " + DBX_RCP + " に保管しますか？")) return;
      try {
        if (!RCP.id) RCP.id = uid("RCP");
        const name =
          "領収_" +
          (RCP.no || RCP.date) +
          "_" +
          (RCP.payee || "宛名").replace(/[\\/:*?"<>|]/g, "_").slice(0, 40) +
          ".html";
        const res = await uploadHtmlToDropbox(
          DBX_RCP,
          name,
          document.getElementById("bdReceiptSheet")?.outerHTML || renderReceiptSheet()
        );
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
    root.querySelectorAll("[data-rload]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        const h = load(LS_RCP).find(function (x) { return x.id === btn.getAttribute("data-rload"); });
        if (!h) return;
        RCP = Object.assign(receiptState(), h);
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

  window.BillingDocs = {
    renderInvoiceApp: renderInvoiceApp,
    renderReceiptApp: renderReceiptApp,
    MIN_MARGIN: MIN_MARGIN,
    ISSUER: ISSUER,
  };
})();
