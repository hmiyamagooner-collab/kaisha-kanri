// 記録できる指標の定義（業種ごとに追加していく）。
// API(/api/records)・円卓(api/openai.js)・画面(records.html は /api/records?meta=1 で取得) が同じ定義を使う。
// 追加するときはここに category を1つ足すだけ（テーブル変更は不要）。
export const CATEGORIES = {
  dayservice_ranking: {
    label: "デイサービス 全国ランキング",
    periodType: "month",           // 'month' = 'YYYY-MM' / 'day' = 'YYYY-MM-DD'
    hint: "毎月メールで届く全国ランキングの本文を貼る",
    items: [
      { key: "全国順位",     unit: "位", lowerIsBetter: true },
      { key: "都道府県順位", unit: "位", lowerIsBetter: true },
      { key: "利用者数",     unit: "人" },
      { key: "稼働率",       unit: "%" },
    ],
  },
};

export const DEFAULT_TENANT = "gooner";

export function categoryOf(id) {
  return CATEGORIES[String(id || "").trim()] || null;
}

// 期間文字列の検証（'YYYY-MM' または 'YYYY-MM-DD'）
export function normPeriod(s, periodType) {
  s = String(s || "").trim().replace(/\//g, "-");
  const m = s.match(/^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/);
  if (!m) return "";
  const y = m[1], mo = String(m[2]).padStart(2, "0"), d = m[3] ? String(m[3]).padStart(2, "0") : "";
  if (periodType === "day") return d ? `${y}-${mo}-${d}` : "";
  return `${y}-${mo}`;
}

// 円卓のシステムプロンプトに載せる説明文（カテゴリ名・項目・単位）
export function categoriesPromptBlock() {
  const lines = ["【記録できる指標（record）】"];
  for (const [id, c] of Object.entries(CATEGORIES)) {
    lines.push(`・category="${id}"（${c.label}）｜period=${c.periodType === "day" ? "YYYY-MM-DD" : "YYYY-MM"}｜項目: ` +
      c.items.map((it) => `${it.key}(${it.unit})`).join(" / "));
  }
  return lines.join("\n");
}
