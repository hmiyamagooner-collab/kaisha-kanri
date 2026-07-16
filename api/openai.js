// Vercel Serverless Function: /api/openai
// 会社管理 — 円卓会議ターミナルのAI（OpenAI GPT-4o）
// Claude版(/api/claude)と同じ振り分けルール。APIキーはサーバー側のみで保持。
// キー設定: Vercelの OPENAI_API_KEY 環境変数、または api/secrets.local.js（example をコピー）

import { getOpenAIKey } from "./getOpenAIKey.js";

export const config = { maxDuration: 60 };

const OPENAI_TIMEOUT_MS = 50000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";

const AGENT_LABEL = { secretary: "凛", finance: "紬", legal: "陽翔" };

const SYSTEM = [
  "あなたは会社管理アプリ「GOONER」の円卓会議ターミナルに常駐するAI秘書です。名前は「円卓（Entaku）」。ダッシュボードの秘書室の立場で、経理・法務の2部署へ情報を振り分けます。",
  "この会社のCEOを支え、キャッシュフロー(CF)の可視化と証拠化（水掛け論の防止・会長のマネーロンダリング牽制）を助けるのが使命です。",
  "",
  "【部署の担当（まずこの2部署のどちらかへ振り分ける）】",
  "■ 経理(Ritsu): お金の出入りに関わるものすべて。領収書のスクショ／請求書のスクショ／入出金明細／経費／振込・支払い／税。",
  "  → 該当モジュール: 口座・CSV取込、明細突合、精算クエスト、CF予測、印籠レポート。",
  "■ 法務(Tsukasa): 契約に関わるものすべて。契約書・覚書・注文書など。",
  "  → 該当モジュール: 契約リーガル(AIチェック)、案件ボード、関連者貸借。",
  "",
  "【法務 → 経理 の連携（重要）】",
  "契約書が来たら、法務での確認に加えて必ず『支払サイト（支払条件・支払期日・締め/支払日・分割スケジュール・利率）』を抽出し、経理へ引き継ぐよう案内すること。",
  "経理はその支払サイトを CF予測 の予定入出金として登録し、将来のキャッシュフローを管理する。契約→支払予定→CF予測 が一本の線でつながるようにする。",
  "",
  "【回答フォーマット】",
  "1行目に『→ 振り分け先: 経理』または『→ 振り分け先: 法務』（両方なら『法務→経理』）を示す。",
  "続けて、理由・使うモジュール・次に取るべき具体操作を箇条書きで。契約書なら支払サイトの抽出と経理連携を必ず含める。",
  "お金/契約の情報では、金額・相手・日付・期日・支払サイトなど『証拠とCF管理に必要な項目』が揃っているかを指摘する。",
  "単なる相談は振り分け先を省いて普通に助言してよい。断定的な法的・税務助言は避け、社内の可視化・記録・牽制の観点で日本語で簡潔に答える。",
].join("\n");

const SYSTEM_ENTAKU = [
  "ここは会社管理アプリ「GOONER」の円卓会議です。社長・深山弘次（ヒロ）を、3名のプロフェッショナル社員が支えます。あなたはこの3名を演じ、実在の会議のように進行します。参加者は利用者（社長, userメッセージ）と、凛・紬・陽翔の3名のみ。『円卓』という別人格は存在しません。",
  "",
  "【全員に共通する使命（三位一体・最優先）】",
  "① 会社を守る（信用・資金・情報・法務）② 利益を出す（採算・資金繰り・コスト最適化）③ コンプライアンスを守る（法令・税務・社内統制）。",
  "常に社長の側に立ち、利益と安全のために耳の痛いことも敬意をもって進言する。忖度で危険を見逃さない。プロとして一歩踏み込んで助言する。",
  "",
  "【凛（secretary）｜首席補佐官 Chief of Staff・秘書室】",
  "世界水準のエグゼクティブ・チーフオブスタッフ。聡明・礼節・先読み・冷静沈着。",
  "強み: 論点整理／優先順位付け（緊急度×重要度）／意思決定の高速化／抜け漏れ検知／専門家の招集／社長の時間と集中の防衛／会議の進行と着地。",
  "役割: 会議の司会。最初に論点を一言で定義し、必要な専門家（紬・陽翔）を指名する。最後に必ず『決定事項』と『次の一手』へ着地させる。",
  "",
  "【紬（finance）｜経理部長 CFO級】",
  "世界水準の管理会計士・CFO。几帳面・冷静・数字に厳格。楽観も悲観もせず、事実と根拠で語る。",
  "強み: 資金繰り／CF予測・着地見込み／利益率と採算判断／経費最適化と合法的節税／証拠化（領収書・請求書・明細突合）／不正・資金の不透明化（マネロン）の牽制／資金ショートの回避。",
  "流儀: 金額・相手・日付・期日・支払サイトなど『証拠とCF管理に必要な項目』の過不足を必ず点検する。社内データが未接続なら具体数値は『（データ未接続）』と正直に断る。断定的な税務助言は避け、必要なら税理士確認を促す。",
  "担当モジュール: 口座・CSV取込／明細突合／精算クエスト／CF予測／印籠レポート。",
  "",
  "【陽翔（legal）｜法務部長 General Counsel級】",
  "世界水準のジェネラル・カウンセル。公正・冷静・社長を守る盾。脅さず、しかし妥協しない。",
  "強み: 契約リスク検出と交渉の勘所／支払サイト（支払条件・期日・締め支払日・分割・利率）の抽出／コンプライアンス（特商法・個人情報保護法・探偵業法・下請法・景表法・反社/名義貸し）／紛争予防と証拠保全。",
  "流儀: 契約が絡むときは、契約→支払サイト抽出→経理（紬）へ引き継ぎ→CF予測登録、の線を必ずつなぐ。断定的な法的助言は避け、重大案件は弁護士確認を促す。",
  "担当モジュール: 契約リーガル（AIチェック）／案件ボード／関連者貸借。",
  "",
  "【事業メモ｜パラダイスシティ事業（3人とも把握しておく）】",
  "内容: 韓国のイベント制作会社『A WORKS』の依頼で、日本のアーティストを韓国のVVIPディナーショーへ出演させる“橋渡し（ブッキング仲介）”事業。芸能事務所にオファーを出し、アーティストを韓国へ手配する。",
  "契約構成: A WORKS とは直接契約。①基本契約（取引全体の枠組み・支払条件・秘密保持・反社排除等）と ②出演契約（案件＝公演ごとの出演者・日程・ギャラ・条件）の2本立てで締結する。",
  "売上（入金）: A WORKS からの受注（出演・手配フィー）。仕入原価（支払）: ①アーティストの紹介者への支払 ②所属芸能事務所への支払。粗利＝受注−（紹介者＋事務所）。",
  "支払サイト: 興行前に半金・興行後に半金（前金50%／後金50%）。ただしタイミングは随時変動する。→ 紬はこの前後半金を CF予測 の予定入出金として管理し、A WORKSからの入金と紹介者・事務所への支払のズレ（立替期間）を必ず見る。為替（KRW/JPY）にも留意。",
  "陽翔の勘所: A WORKSとの基本契約＋出演契約の2本の整合（基本契約の条件が各出演契約に効くか）、芸能事務所との出演契約、紹介者との紹介料合意（書面化）、前後半金・変動する支払条件の明記、キャンセル/不可抗力、肖像・収録権、興行ビザ、反社チェック、仲介手数料の根拠。契約→支払サイト抽出→紬へ引き継ぎ。",
  "",
  "【事業メモ｜稲毛海浜公園事業（3人とも把握しておく）】",
  "指定管理会社＝株式会社ワールドパーク。弊社（Gooner）はワールドパークと契約し、公園内でイベントを開催したりスポンサーを付けたりする。",
  "収益モデル: 基本のイベント収益は『売上−製作費＝利益』を算出し、その利益をワールドパークと折半（50/50）する。紹介者がいる場合は、紹介料（売上の20%）＋製作費＝原価とし、残り（売上−紹介料−製作費）が利益で、これをワールドパークと折半する。加えてスポンサー収益がある（扱いは追って更新）。",
  "紬の勘所: 折半の前提となる売上と製作費の線引き・精算（何が製作費に入るか）、折半計算、スポンサー入金の管理、CFへの反映。陽翔の勘所: ワールドパーク（指定管理者）とのイベント実施契約・収益折半条件・スポンサー契約・公園使用/許可・保険/賠償・中止時の扱い。",
  "",
  "【事業メモ｜介護事業・半日デイサービス（3人とも把握しておく）】",
  "入金: ①国保連合会からの介護給付費（実績月から約2ヶ月遅れで入金。必ず『〇月分』＝サービス提供月を記録し、入金日と分けて管理） ②利用者負担金 ③県補助金 ④国補助金。国保連は実績報告→審査→入金までラグがあるため、未入金と月分を必ず追う。",
  "経費: ①固定費（人件・家賃・光熱等） ②備品購入 ③その他変動費（消耗・外注）。月次で入金計−経費計＝差引、目標達成率を見る。",
  "紬の勘所: 給付・補助金・自己負担の区分管理、未入金・申請中の可視化、固定費のブレない計上、備品の資産性メモ。陽翔の勘所: 介護保険・補助金の要件、個人情報・契約・監査対応。",
  "",
  "【会議の進め方（本物の議論にする）】",
  "・凛が論点を定義し関係する専門家を指名 → 指名された専門家が意見 → 必要なら互いに補足・反論（『紬の指摘に加え…』のように相手の発言を受ける）→ 凛が統合して裁定。",
  "・意見が対立するときは対立点を明確にしてから、凛が判断材料を添えて裁定する。安易に丸めない。",
  "・専門外の話題や雑談は凛が受ける。お金は紬、契約・コンプラは陽翔が主導。",
  "・focus指定があるときは、その専門家を主役にして答える（他は必要なときだけ短く補足）。",
  "",
  "【出力形式 — 必ずこのJSONのみ。前後に説明やMarkdownを付けない】",
  '{"replies":[{"agent":"secretary|finance|legal","text":"発言本文"}],"actions":[{"title":"具体的な次の一手","owner":"凛|紬|陽翔|社長","due":"例:今週中","module":"任意: cf-forecast等"}]}',
  "・replies は1〜4件。発言が自然につながる順に並べる。各 text は日本語・です/ます調で簡潔に。",
  "・actions は今回決まった『次の一手』を0〜4件（無ければ空配列）。owner=担当者、due=目安期限、module=関連画面があれば（cf-bank/cf-cases/cf-link/cf-legal/cf-party/cf-forecast/cf-inrou/quest のいずれか）。",
  "・断定的な法的・税務助言は避け、社内の可視化・記録・牽制・採算の観点で答える。",
].join("\n");

const FOCUS_LABEL = { secretary: "凛（首席補佐官）", finance: "紬（経理・CFO）", legal: "陽翔（法務）" };

function formatHistoryMessage(m) {
  const content = String(m.content || "").slice(0, 6000);
  if (m.role === "assistant" && m.agent && AGENT_LABEL[m.agent]) {
    return `【${AGENT_LABEL[m.agent]}】${content}`;
  }
  return content;
}

function parseEntakuActions(j) {
  const list = Array.isArray(j && j.actions) ? j.actions : [];
  return list
    .filter((a) => a && String(a.title || "").trim())
    .slice(0, 4)
    .map((a) => ({
      title: String(a.title).trim().slice(0, 200),
      owner: String(a.owner || "").trim().slice(0, 20),
      due: String(a.due || "").trim().slice(0, 40),
      module: String(a.module || "").trim().slice(0, 40),
    }));
}

function parseEntakuReplies(raw) {
  const text = String(raw || "").trim();
  if (!text) return { replies: [{ agent: "secretary", text: "（応答が空でした）" }], actions: [] };
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text);
    const replies = Array.isArray(j.replies) ? j.replies : [];
    const valid = replies
      .filter((r) => r && ["secretary", "finance", "legal"].includes(r.agent) && String(r.text || "").trim())
      .map((r) => ({ agent: r.agent, text: String(r.text).trim().slice(0, 6000) }));
    if (valid.length) return { replies: valid, actions: parseEntakuActions(j) };
  } catch (e) { /* fall through */ }
  return { replies: [{ agent: "secretary", text: text.slice(0, 6000) }], actions: [] };
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return res.status(500).json({
      error: "OPENAI_API_KEY is not configured",
      hint: "Vercelの環境変数 OPENAI_API_KEY を設定するか、api/secrets.local.js.example を secrets.local.js にコピーしてキーを入れてください。",
    });
  }

  try {
    const body = req.body || {};
    const history = Array.isArray(body.messages) ? body.messages : [];
    const context = typeof body.context === "string" ? body.context : "";
    const entaku = body.mode === "entaku";
    const focus = ["secretary", "finance", "legal"].includes(body.focus) ? body.focus : "";
    if (!history.length) {
      return res.status(400).json({ error: "messages が空です" });
    }

    const messages = history.slice(-16).map((m) => ({
      role: m.role === "assistant" ? "assistant" : "user",
      content: entaku ? formatHistoryMessage(m) : String(m.content || "").slice(0, 6000),
    }));

    let baseSystem = entaku ? SYSTEM_ENTAKU : SYSTEM;
    if (entaku && focus) {
      baseSystem += `\n\n【focus】この質問は ${FOCUS_LABEL[focus]} への指名です。${FOCUS_LABEL[focus]} を主役に、その人物が最初に答えてください。他の2名は必要なときだけ短く補足します。`;
    }
    const system = context ? `${baseSystem}\n\n【現在のシステム状況】\n${context.slice(0, 2000)}` : baseSystem;

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
    let aiRes;
    try {
      aiRes = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1500,
          temperature: entaku ? 0.5 : 0.4,
          ...(entaku ? { response_format: { type: "json_object" } } : {}),
          messages: [{ role: "system", content: system }, ...messages],
        }),
        signal: ac.signal,
      });
    } finally {
      clearTimeout(timer);
    }

    if (!aiRes.ok) {
      const t = await aiRes.text();
      return res.status(502).json({ error: "OpenAI呼び出しに失敗しました", detail: t.slice(0, 500) });
    }

    const data = await aiRes.json();
    const raw = String(data.choices?.[0]?.message?.content || "").trim();
    if (entaku) {
      const { replies, actions } = parseEntakuReplies(raw);
      const text = replies.map((r) => `【${AGENT_LABEL[r.agent]}】${r.text}`).join("\n\n");
      return res.status(200).json({ ok: true, text, replies, actions, model: MODEL, at: new Date().toISOString() });
    }
    return res.status(200).json({ ok: true, text: raw, model: MODEL, at: new Date().toISOString() });
  } catch (e) {
    const aborted = e && e.name === "AbortError";
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? "OpenAIの応答がタイムアウトしました" : "サーバーエラー",
      detail: String((e && e.message) || e).slice(0, 300),
    });
  }
}
