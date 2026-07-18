// Vercel Serverless Function: /api/doc-route
// 円卓添付のPDF/資料テキストを分類し、保管先モジュールへ振り分ける

import { getOpenAIKey } from "./getOpenAIKey.js";

export const config = { maxDuration: 45 };

const OPENAI_TIMEOUT_MS = 40000;
const MODEL = process.env.OPENAI_DOC_MODEL || process.env.OPENAI_MODEL || "gpt-4o-mini";

const ROUTES = [
  "cf",
  "bank_csv",
  "legal",
  "contracts",
  "cases",
  "meeting_finance",
  "meeting_sales",
  "meeting_other",
  "entry",
  "other",
];

function heuristic(fileName, text) {
  const b = `${fileName || ""}\n${String(text || "").slice(0, 4000)}`;
  if (/\.csv\b|text\/csv|freee|フリー|マネーフォワード|money\s*forward|moneyforward|借方金額|貸方金額|収支区分|勘定科目/i.test(b)) {
    return { route: "bank_csv", label: "口座・CSV", summary: "freee／マネーフォワード／銀行CSVと判定", confidence: 0.75 };
  }
  if (/CF|キャッシュ|入出金|資金繰|収支|キャッシュフロー|予定表/i.test(b) && !/\.csv\b/i.test(fileName || "")) {
    return { route: "cf", label: "CF", summary: "キャッシュフロー表・入出金資料と判定", confidence: 0.55 };
  }
  if (/契約|覚書|合意書|約款|NDA|リーガル|業務委託/i.test(b)) {
    return { route: "legal", label: "契約リーガル", summary: "契約関連資料と判定", confidence: 0.55 };
  }
  if (/議事|ミーティング|MTG|会議録|アジェンダ/i.test(b)) {
    if (/経理|財務|会計|資金/i.test(b)) {
      return { route: "meeting_finance", label: "経理会議", summary: "経理会議資料と判定", confidence: 0.5 };
    }
    if (/営業|セールス|顧客|受注/i.test(b)) {
      return { route: "meeting_sales", label: "営業会議", summary: "営業会議資料と判定", confidence: 0.5 };
    }
    return { route: "meeting_other", label: "その他MT", summary: "会議資料と判定", confidence: 0.45 };
  }
  if (/領収|請求書|レシート|経費|インボイス/i.test(b)) {
    return { route: "entry", label: "記録する", summary: "領収・請求資料と判定", confidence: 0.5 };
  }
  if (/案件|発注|見積/i.test(b)) {
    return { route: "cases", label: "イレギュラー案件ボード", summary: "案件関連資料と判定", confidence: 0.45 };
  }
  return { route: "other", label: "資料保管", summary: "一般資料として保管", confidence: 0.3 };
}

function normalize(raw, fileName, text) {
  const h = heuristic(fileName, text);
  let route = String(raw?.route || h.route || "other").trim();
  if (!ROUTES.includes(route)) route = h.route;
  const labelMap = {
    cf: "CF",
    bank_csv: "口座・CSV",
    legal: "契約リーガル",
    contracts: "契約書",
    cases: "イレギュラー案件ボード",
    meeting_finance: "経理会議",
    meeting_sales: "営業会議",
    meeting_other: "その他MT",
    entry: "記録する",
    other: "資料保管",
  };
  const confidence = Math.max(0, Math.min(1, Number(raw?.confidence ?? h.confidence) || 0.4));
  const textLen = String(text || "").trim().length;
  const needsClarification =
    raw?.needsClarification === true ||
    route === "other" ||
    confidence < 0.45 ||
    (textLen < 40 && route !== "cf" && route !== "bank_csv");
  return {
    route,
    module: {
      cf: "biz-cf",
      bank_csv: "cf-bank",
      legal: "cf-legal",
      contracts: "contracts",
      cases: "cf-cases",
      meeting_finance: "mtg-finance",
      meeting_sales: "mtg-sales",
      meeting_other: "mtg-other",
      entry: "entry",
      other: "dash",
    }[route],
    label: String(raw?.label || labelMap[route] || h.label).slice(0, 40),
    summary: String(raw?.summary || h.summary || "").slice(0, 800),
    title: String(raw?.title || fileName || "資料").slice(0, 120),
    counterparty: String(raw?.counterparty || "").slice(0, 80),
    amount: raw?.amount == null || raw?.amount === "" ? null : Number(raw.amount),
    confidence,
    needsClarification,
    askUser: needsClarification
      ? "この添付資料が何のデータか（CF・契約・会議・領収など）を教えてください。"
      : "",
  };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const body = req.body || {};
  const fileName = String(body.fileName || "document.pdf").slice(0, 160);
  const text = String(body.text || "").trim();
  const kind = String(body.kind || "pdf");

  if (!text && kind === "pdf") {
    const fallback = normalize(null, fileName, "");
    return res.status(200).json({ ok: true, ...fallback, note: "テキストなしのためファイル名で判定" });
  }

  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return res.status(200).json({ ok: true, ...normalize(null, fileName, text), note: "AI未設定のためヒューリスティック判定" });
  }

  try {
    const system = [
      "あなたは会社管理アプリGOONERの資料振り分けAIです。",
      "添付資料の種別を判定し、保管先ルートを1つ選びます。",
      "出力はJSONのみ:",
      JSON.stringify({
        route: "cf|bank_csv|legal|contracts|cases|meeting_finance|meeting_sales|meeting_other|entry|other",
        label: "日本語の保管先名",
        title: "資料タイトル",
        summary: "1〜3文の要約",
        counterparty: "相手方が分かれば",
        amount: "金額数値またはnull",
        confidence: 0.0,
      }),
      "判定の目安:",
      "・freee／マネーフォワード／銀行のCSV明細→bank_csv",
      "・月次CF・入出金表PDF→cf",
      "・契約書本文のチェック向け→legal",
      "・契約台帳に載せる契約概要→contracts",
      "・案件関連→cases",
      "・会議の議事録/アジェンダ→meeting_*",
      "・領収書・請求書→entry",
      "・不明→other（confidenceは0.35以下にし needsClarification 相当）",
      "判別が曖昧なら confidence を低くする（0.45未満）。",
    ].join("\n");

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
    let aiRes;
    try {
      aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: MODEL,
          temperature: 0.1,
          max_tokens: 700,
          response_format: { type: "json_object" },
          messages: [
            { role: "system", content: system },
            {
              role: "user",
              content: `ファイル名: ${fileName}\n種別: ${kind}\n本文:\n"""\n${text.slice(0, 12000)}\n"""`,
            },
          ],
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!aiRes.ok) {
      const detail = await aiRes.text().catch(() => "");
      return res.status(200).json({
        ok: true,
        ...normalize(null, fileName, text),
        note: "AI判定失敗のためヒューリスティック",
        detail: detail.slice(0, 200),
      });
    }
    const data = await aiRes.json();
    const rawText = data?.choices?.[0]?.message?.content || "{}";
    let parsed = {};
    try {
      const m = String(rawText).match(/\{[\s\S]*\}/);
      parsed = JSON.parse(m ? m[0] : rawText);
    } catch (e) {
      parsed = {};
    }
    return res.status(200).json({ ok: true, ...normalize(parsed, fileName, text) });
  } catch (e) {
    return res.status(200).json({
      ok: true,
      ...normalize(null, fileName, text),
      note: "例外のためヒューリスティック",
      error: String(e && e.message ? e.message : e).slice(0, 200),
    });
  }
}
