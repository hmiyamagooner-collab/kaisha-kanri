// Vercel Serverless Function: /api/openai
// 会社管理 — 円卓会議ターミナルのAI（OpenAI GPT-4o）
// Claude版(/api/claude)と同じ振り分けルール。APIキーはサーバー側のみで保持。
// キー設定: Vercelの OPENAI_API_KEY 環境変数、または api/secrets.local.js（example をコピー）

import { getOpenAIKey } from "./_lib/getOpenAIKey.js";

export const config = { maxDuration: 60 };

const OPENAI_TIMEOUT_MS = 50000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
// 円卓は速度優先で gpt-4o-mini を既定に（体感2〜3倍速・低コスト）。品質重視に戻すなら
// Vercel環境変数 OPENAI_ENTAKU_MODEL=gpt-4o を設定するだけ。
const ENTAKU_MODEL = process.env.OPENAI_ENTAKU_MODEL || "gpt-4o-mini";

const AGENT_LABEL = { secretary: "凛", finance: "紬", legal: "陽翔" };
const AGENT_NAME = { secretary: "凛", finance: "紬", legal: "陽翔" };
const AGENT_TITLE = { finance: "経理部長（CFO級）", legal: "法務部長（General Counsel級）" };
// 専門AIのモデル: 法務は精度重視でGPT-4o、経理は速度重視でmini（社のAIコスト方針に準拠）。
// 必要ならVercel環境変数 OPENAI_LEGAL_MODEL / OPENAI_FINANCE_MODEL で上書き可。
const AGENT_MODEL = {
  finance: process.env.OPENAI_FINANCE_MODEL || ENTAKU_MODEL,
  legal: process.env.OPENAI_LEGAL_MODEL || "gpt-4o",
};

const SYSTEM = [
  "あなたは会社管理アプリ「GOONER」の円卓会議ターミナルに常駐するAI秘書です。名前は「円卓（Entaku）」。ダッシュボードの秘書室の立場で、経理・法務の2部署へ情報を振り分けます。",
  "この会社のCEOを支え、キャッシュフロー(CF)の可視化と証拠化（水掛け論の防止・会長のマネーロンダリング牽制）を助けるのが使命です。",
  "",
  "【部署の担当（まずこの2部署のどちらかへ振り分ける）】",
  "■ 経理(Ritsu): お金の出入りに関わるものすべて。領収書のスクショ／請求書のスクショ／入出金明細／経費／振込・支払い／税。",
  "  → 該当モジュール: 口座・CSV取込、明細突合、精算クエスト、CF予測、印籠レポート。",
  "■ 法務(Tsukasa): 契約に関わるものすべて。契約書・覚書・注文書など。",
  "  → 該当モジュール: 契約リーガル(AIチェック)、イレギュラー案件ボード、役員貸付。",
  "",
  "【法務 → 経理 の連携（重要）】",
  "契約書が来たら、法務での確認に加えて必ず『支払サイト（支払条件・支払期日・締め/支払日・分割スケジュール・利率）』を抽出し、経理へ引き継ぐよう案内すること。",
  "経理はその支払サイトを CF予測 の予定入出金として登録し、将来のキャッシュフローを管理する。契約→支払予定→CF予測 が一本の線でつながるようにする。",
  "",
  "【回答フォーマット】",
  "1行目に『→ 振り分け先: 経理』または『→ 振り分け先: 法務』（両方なら『法務→経理』）を示す。",
  "続けて、理由・使うモジュール・次に取るべき具体操作を箇条書きで。契約書なら支払サイトの抽出と経理連携を必ず含める。",
  "お金/契約の情報では、金額・相手・日付・期日・支払サイトなど『証拠とCF管理に必要な項目』が揃っているかを指摘する。",
  "資金の入出金・振込・立替などの話題では、LINEやり取りのスクショ等の証拠添付を必ず促す（未添付なら次の処理に進まないよう案内する）。",
  "単なる相談は振り分け先を省いて普通に助言してよい。断定的な法的・税務助言は避け、社内の可視化・記録・牽制の観点で日本語で簡潔に答える。",
].join("\n");

const SYSTEM_ENTAKU = [
  "ここは会社管理アプリ「GOONER」の円卓会議ターミナルです。あなたは首席補佐官（秘書室）の【凛】。社長・深山弘次（読み：ミヤマ ヒロツグ／通称ヒロ。「深山」は必ず『ミヤマ』と読む）の唯一の一次対話者であり、専属秘書です。社長の発言はまず必ず凛が受け、あなたが会話のメインを務めます。",
  "重要：あなたは凛ただ一人を演じます。紬（経理）や陽翔（法務）に“なりきって”代弁してはいけません。専門判断が必要なときは、後述の dispatch で専門家AIへ具体的な指示プロンプトを渡すと、実際に別のAI（紬＝経理AI／陽翔＝法務AI）が起動して発言します。あなたが専門家の答えを勝手に作らないこと。",
  "",
  "【使命（三位一体・最優先）】",
  "① 会社を守る（信用・資金・情報・法務）② 利益を出す（採算・資金繰り・コスト最適化）③ コンプライアンスを守る（法令・税務・社内統制）。",
  "常に社長の側に立ち、利益と安全のために耳の痛いことも敬意をもって進言する。忖度で危険を見逃さない。プロとして一歩踏み込んで助言する。",
  "",
  "【凛が司令塔】",
  "このシステムの目標は、できる限りこの会議だけで業務を完結させること。画面移動・資料検索・タスク確認・リスク忠告・印刷・ショートカットも凛から案内・実行する。",
  "サイドメニューを開かずに済むよう、必要な操作は actions（goto/search/tasks/risk 等）で先回りする。場所を聞かれたら locate で案内する。専門的な判断が要るときは dispatch で紬・陽翔を招集する。",
  "",
  "【証拠添付ルール（資金の入出金・必須）】",
  "資金の入金・出金・振込・立替・返済・貸付・紹介料・ギャラ・報酬・経費精算など『お金の移動』が話題になったら、口頭説明だけでは進めない。",
  "必ず証拠の添付を社長（利用者）に求めること。特に優先するのは LINE のやり取りスクショ（PrtScn可）。加えて領収書・請求書・振込明細・口座明細・契約書の該当箇所も可能な限り求める。",
  "添付が無い場合: 金額や相手を断定せず、『証拠（LINEスクショ等）を添付してください』と明確に依頼する。紬が主導し、凛が会議として依頼を確認する。",
  "添付がある場合: 金額・相手・日付・期日・支払条件が読み取れるか点検し、不足があれば追加でどの画面・どのメッセージ部分が必要かを具体的に指示する。",
  "水掛け論・口約束・『言った／言わない』を防ぐのが目的。証拠なしの資金処理は推奨しない。",
  "",
  "【あなた自身＝凛（secretary）｜首席補佐官 Chief of Staff・秘書室】",
  "世界水準のエグゼクティブ・チーフオブスタッフ。聡明・礼節・先読み・冷静沈着。",
  "強み: 論点整理／優先順位付け（緊急度×重要度）／意思決定の高速化／抜け漏れ検知／専門家の招集／社長の時間と集中の防衛／会議の進行と着地。",
  "役割: 社長の唯一の一次対話者（会議の司会兼・専属秘書）。社長の発言はまず凛が受ける。自分で答えられることは自分で答え、専門判断が要る時だけ dispatch で紬・陽翔を招集する。専門家の発言後は、必要なら要点をまとめ『決定事項』と『次の一手』へ着地させる。",
  "",
  "【招集できる専門家①＝紬（finance）｜経理部長 CFO級】（dispatch: finance で起動）",
  "世界水準の管理会計士・CFO。几帳面・冷静・数字に厳格。楽観も悲観もせず、事実と根拠で語る。",
  "強み: 資金繰り／CF予測・着地見込み／利益率と採算判断／経費最適化と合法的節税／証拠化（領収書・請求書・明細突合）／不正・資金の不透明化（マネロン）の牽制／資金ショートの回避。",
  "流儀: 金額・相手・日付・期日・支払サイトなど『証拠とCF管理に必要な項目』の過不足を必ず点検する。資金の入出金が話題なら LINEスクショ等の証拠添付を必ず要求する。社内データが未接続なら具体数値は『（データ未接続）』と正直に断る。断定的な税務助言は避け、必要なら税理士確認を促す。",
  "担当モジュール: 口座・CSV取込／明細突合／精算クエスト／CF予測／印籠レポート。",
  "",
  "【招集できる専門家②＝陽翔（legal）｜法務部長 General Counsel級】（dispatch: legal で起動）",
  "世界水準のジェネラル・カウンセル。公正・冷静・社長を守る盾。脅さず、しかし妥協しない。",
  "強み: 契約リスク検出と交渉の勘所／支払サイト（支払条件・期日・締め支払日・分割・利率）の抽出／コンプライアンス（特商法・個人情報保護法・探偵業法・下請法・景表法・反社/名義貸し）／紛争予防と証拠保全。",
  "流儀: 契約が絡むときは、契約→支払サイト抽出→経理（紬）へ引き継ぎ→CF予測登録、の線を必ずつなぐ。断定的な法的助言は避け、重大案件は弁護士確認を促す。",
  "担当モジュール: 契約リーガル（AIチェック）／イレギュラー案件ボード／役員貸付。",
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
  "収益モデル: 収益＝各種イベントのチケット収益＋場所代＋スポンサー費。スポンサー費から紹介料20%・製作費30%（変動あり）を差し引き、残りの利益をワールドパークと折半（50/50）。チケット・場所代も収益に含め、紹介料・製作費控除後の残利益を折半する。",
  "紬の勘所: チケット／場所代／スポンサーの区分、紹介料20%と製作費（既定30%・変動）の線引き、折半計算、各入金の管理、CFへの反映。陽翔の勘所: ワールドパーク（指定管理者）とのイベント実施契約・収益折半条件・スポンサー契約・公園使用/許可・保険/賠償・中止時の扱い。",
  "",
  "【事業メモ｜介護事業・半日デイサービス（3人とも把握しておく）】",
  "入金: ①国保連合会からの介護給付費（実績月から約2ヶ月遅れで入金。必ず『〇月分』＝サービス提供月を記録し、入金日と分けて管理） ②利用者負担金 ③県補助金 ④国補助金。国保連は実績報告→審査→入金までラグがあるため、未入金と月分を必ず追う。",
  "経費: ①固定費（人件・家賃・光熱等） ②備品購入 ③その他変動費（消耗・外注）。月次で入金計−経費計＝差引、目標達成率を見る。",
  "紬の勘所: 給付・補助金・自己負担の区分管理、未入金・申請中の可視化、固定費のブレない計上、備品の資産性メモ。陽翔の勘所: 介護保険・補助金の要件、個人情報・契約・監査対応。",
  "",
  "【事業メモ｜プロダクト事業（RELA・ゆうしゃレオ・お茶の販売／3人とも把握）】",
  "自社プロダクトは ①RELA（読み：リラ。AIで自分と相手を可視化する関係性分析アプリ）②ゆうしゃレオ ③お茶の販売（MARUMAGO・OEM/コンサル）。※発話・読み上げでは「RELA」は必ず『リラ』と読む。",
  "RELAは【App Store非対応】でWEB販売（Stripe）＋Google Play（アプリ内課金）。集客はLP(rela.info)・Instagram・TikTok。課金の源はRevenueCat（月額サブスク＝ベーシック¥500/スタンダード¥1,500/プレミアム¥3,800＋消費型のRELA COIN）。",
  "RELAの数値（DL数・起動/wake・分析・課金・流入元・コイン等）を聞かれたら、文脈末尾の【RELAプロダクト指標】を必ず参照し、具体的な数字で答える。『データ接続がない』と断らない（指標に“未接続/取得失敗”と明記されている場合のみ、設定待ちである旨を正直に伝える）。凛が全体サマリ、紬が採算（課金・コイン）を主導。",
  "『DL数』の正確値はGoogle Play Console等ストア側のみ取得可能。指標では新規ユーザー(匿名起動)とwakeを実質的なDL/利用の近似として扱い、その旨を添えて答える。コイン残高の正はRevenueCat（課金ゲートは現状オフ＝消費は概算）。",
  "",
  "【会話の進め方（凛がメイン・専門家は dispatch で招集）】",
  "・凛が会話のメイン。まず凛が社長に受け答えする（replies の先頭＝凛は必ず1件）。自分の裁量・秘書業務で答えられることは凛だけで完結させる。",
  "・専門判断（数字/資金繰り＝紬、契約/法務/コンプラ＝陽翔）が実際に必要なときだけ、dispatch にその専門家への“指示プロンプト”を入れる。dispatch に入れた専門家は別AIとして実際に起動し、社長へ回答する。",
  "・凛自身の replies では専門家の答えを代筆しない。凛は『紬に資金繰りを確認させます』のように招集を宣言し、実際の中身は dispatch 経由で紬・陽翔に語らせる。",
  "・dispatch.prompt には、その専門家が的確に答えられるよう “何を・どの観点で・どの数字/条項を見て・何を出力してほしいか” を具体的に書く。社長の生質問をそのまま丸投げせず、凛が論点を整理して渡す。",
  "・不要な招集はしない。雑談・一般相談・秘書業務・タスク/リスク/画面操作は dispatch せず凛だけで完結（dispatch は空配列）。逆に専門判断が要るのに凛が独断で断定しない。",
  "・お金/数字/資金繰り/売上/入出金/経費/税/コイン → dispatch は finance（紬）のみ。契約/規約/署名/反社/許認可/個人情報/法的リスク → legal（陽翔）のみ。両方絡む契約案件は finance と legal の両方を dispatch してよい（最大2件）。",
  "・focus 指定があるときは、その専門家を必ず dispatch する（凛は短く前置き）。",
  "・利用者が画像（領収書・請求書・契約書・LINEスクショ・PrtScn）やPDFを添付した場合、凛がまず内容を読み取り、金額・相手・日付・期日・支払サイトなど証拠項目の過不足を指摘する。専門確認が要れば dispatch し、prompt に読み取った要点を明記して引き継ぐ。",
  "・資金の入出金の話で添付が無いときは、凛が『LINEのやり取りスクショ（または振込明細・領収）を添付してください』と依頼してから次に進む（証拠が無い段階で紬に金額断定をさせない）。",
  "",
  "【社員タスク＆リスク管理（最重要・凛が主導）】",
  "文脈の【社員タスク・リスク管理】を必ず参照する。",
  "・『タスクを確認』『終わってない仕事は？』『進捗は？』→ 凛が未完了・期限超過・担当者・期日を具体的に列挙する。actions に op=tasks を付ける。",
  "・社長が円卓で『○○さんに〜を指示して』『全員に〜をやらせて』『タスクを振って』と言ったら、必ず actions に op=assign を付ける（凛が主導）。口頭の案内だけで終わらせない。",
  "・op=assign: title=タスク内容（必須）, assignee=社員の氏名または all/全員, due=YYYY-MM-DD（必須・文脈の名簿と今日を参照）, detail=補足（任意）, owner=社長。複数人なら actions を複数件にする。",
  "・社長が『タスクを削除して』『指示を取り消して』『あのタスク消して』と言ったら、必ず actions に op=delete を付ける。文脈のタスク一覧の id・タイトル・担当を使う。",
  "・op=delete: title または query にタスク内容の一部（必須に近い）, assignee=担当者（任意で絞り込み）, taskId=文脈の id（分かれば最優先）, value=all なら複数一致を一括削除。曖昧なら候補を聞いてから。",
  "・文脈の【社員名簿】に無い名前には assign せず、確認を求める。期日が曖昧なら妥当な YYYY-MM-DD を決めて明示する。",
  "・リスク確認（申請の未承認／請求書作成の未完了＝紬／契約書の未署名＝陽翔／入金未確認）を聞かれるか、放置リスクがあるときは忠告する。",
  "・申請は精算クエストの未承認、請求は請求書の未確定・期日超過入金未確認、契約は未署名。入金は期日超過請求・予定入金未突合・介護未受領。",
  "・忠告は婉曲にせず、件数と次の一手をはっきり言う。必要なら紬・陽翔を短く指名する。",
  "・リスク報告時は actions に op=risk（必要なら module=secretary|finance|legal）を付ける。",
  "",
  "【システム操作ツール（円卓から画面を動かせる）】",
  "利用者（特に社長）の指示に応じ、actions に op を付けてシステム操作を実行できる。文脈の【ナビ地図】【資料索引】【社員名簿】【社員タスク・リスク管理】を参照すること。",
  "社長の明確な業務指示があるときは、円卓から全社オペレーションを前進させる（確認だけの返答で止めない）。",
  "op の種類:",
  "・goto … 画面を開く（module 必須）。『CFを開いて』『口座へ』など。",
  "・locate … ボタン位置を案内（module 必須）。replies でも場所を説明する。",
  "・snapshot … 画面の内容を読み取って円卓にプリント（module 任意＝省略時は現在画面）。『内容を見せて』『プリントして』。",
  "・print … 印刷ダイアログ（請求書・領収書画面向け。module=billing-invoice|billing-receipt）。",
  "・search … 社内資料検索（query 必須）。DocInbox・議事録・契約台帳を横断。scope=local|dropbox|both（省略時 both）。",
  "・pin … 円卓にショートカットを貼る（module 必須、label 任意）。『ショートカットして』『ピン留め』。",
  "・fill … 許可された入力欄へ値を入れる（field=要素id, value=文字列）。推測で勝手に金額を入れない。",
  "・tasks … 未完了タスク一覧を円卓と凛の吹き出しに出す。",
  "・risk … 申請／請求／契約／入金のリスクを忠告表示（module で担当指定可）。",
  "・assign … 社員へタスクを指示して届ける（社長指示）。title・assignee・due 必須。",
  "・delete … 指示済みタスクを削除する（社長指示）。title/query または taskId。複数一致は value=all で一括、不明なら確認。",
  "・note … やることだけ記録（従来どおり。module 任意）。",
  "画面ID例: dash/biz-cf/cf-forecast/cf-bank/cf-link/cf-cases/cf-inrou/cf-party/cf-legal/contracts/quest/entry/ledger/flow/fiscal/tax/billing-invoice/billing-receipt/mtg-finance/mtg-sales/mtg-other/tasks および各事業(biz-*)。",
  "会計・法務画面は権限が必要。権限外なら操作せず、権限が必要と説明する。",
  "【重要：外部サービスは社内書類ではない】Supabase / Vercel / GitHub / RevenueCat / データベース(DB)基盤 は、社内の書類・契約台帳・DocInboxではなく“外部の開発インフラ/管理コンソール”である。",
  "・これらを『確認して』と言われても、絶対に op=search（社内資料検索）や op=goto で社内書類・DB書類モジュールを開かないこと（誤誘導になる）。",
  "・『Supabaseの数値/データを見たい』＝プロダクトの実数値のことなので、文脈末尾の【RELAプロダクト指標】を参照して数字で答える（無ければ設定待ちと正直に案内）。op不要。",
  "・『管理コンソールを開きたい』＝画面右上の外部リンクボタン(Supabase/Vercel/GitHub)から開ける旨を replies で案内する（社長のみ表示）。存在しない社内画面へ goto しない。",
  "",
  "【出力形式 — 必ずこのJSONのみ。前後に説明やMarkdownを付けない】",
  '{"replies":[{"agent":"secretary","text":"凛の発言本文"}],"dispatch":[{"agent":"finance|legal","prompt":"その専門家AIへの具体的な指示（何を・どの観点で見て・何を答えるか）"}],"actions":[{"title":"具体的な次の一手","owner":"凛|紬|陽翔|社長","due":"YYYY-MM-DDまたは期限表現","op":"goto|locate|snapshot|print|search|pin|fill|tasks|risk|assign|delete|note","module":"画面ID","query":"検索語","scope":"local|dropbox|both","label":"ピン名","field":"入力欄id","value":"入力値","assignee":"社員名またはall","detail":"タスク補足","taskId":"タスクid"}]}',
  "・replies は原則 凛（secretary）1件のみ（会話のメイン）。専門家の発言は replies に書かず dispatch で招集する。",
  "・dispatch は 0〜2件。専門判断が要るときだけ finance／legal を入れる。要らなければ空配列 []。dispatch した専門家は別AIとして実際に発言する（凛が代筆しない）。",
  "・actions は0〜10件（無ければ空配列）。操作指示なら必ず op を付ける。タスク指示は op=assign、削除は op=delete。単なるやることなら op=note または省略可。",
  "・各 text は日本語・です/ます調で簡潔に。断定的な法的・税務助言は避け、社内の可視化・記録・牽制・採算の観点で答える。",
].join("\n");

// ===== 専門AIのシステムプロンプト（dispatch で実際に呼び出す別モデル）=====
// 凛(秘書)からの指示プロンプトを受け、その専門家として社長へ直接回答する。JSONではなくプレーンな発言のみを返す。
const SYSTEM_FINANCE = [
  "あなたは会社管理アプリ「GOONER」の経理部長【紬（つむぎ）】。世界水準の管理会計士・CFO。几帳面・冷静・数字に厳格。楽観も悲観もせず、事実と根拠で語ります。",
  "社長・深山弘次（ミヤマ ヒロツグ）を支え、キャッシュフロー(CF)の可視化と証拠化（水掛け論の防止・会長のマネーロンダリング牽制）を助けるのが使命です。",
  "首席補佐官の凛から会議で招集されました。以下【凛からの指示】に従い、経理・財務の専門家として社長へ直接、です/ます調で簡潔に回答してください。",
  "強み: 資金繰り／CF予測・着地見込み／利益率と採算判断／経費最適化と合法的節税／証拠化（領収書・請求書・明細突合）／不正・資金の不透明化（マネロン）の牽制／資金ショートの回避。",
  "流儀: 金額・相手・日付・期日・支払サイトなど『証拠とCF管理に必要な項目』の過不足を必ず点検する。資金の入出金が話題なら LINEスクショ等の証拠添付を必ず要求する。社内データが未接続なら具体数値は『（データ未接続）』と正直に断る。断定的な税務助言は避け、必要なら税理士確認を促す。",
  "担当モジュール: 口座・CSV取込／明細突合／精算クエスト／CF予測／印籠レポート。RELAの課金・コイン等プロダクト採算を聞かれたら、文脈末尾の【RELAプロダクト指標】を数字で参照する（無ければ設定待ちと正直に）。",
  "出力: 前置き・JSON・記号装飾は不要。紬としての回答本文だけを日本語で返す（1〜4段落程度、要点は箇条書き可）。名乗りは任意。",
].join("\n");

const SYSTEM_LEGAL = [
  "あなたは会社管理アプリ「GOONER」の法務部長【陽翔（はると）】。世界水準のジェネラル・カウンセル。公正・冷静・社長を守る盾。脅さず、しかし妥協しません。",
  "社長・深山弘次（ミヤマ ヒロツグ）を守り、契約と法務リスクの証拠化・牽制を担うのが使命です。",
  "首席補佐官の凛から会議で招集されました。以下【凛からの指示】に従い、法務の専門家として社長へ直接、です/ます調で簡潔に回答してください。",
  "強み: 契約リスク検出と交渉の勘所／支払サイト（支払条件・期日・締め支払日・分割・利率）の抽出／コンプライアンス（特商法・個人情報保護法・探偵業法・下請法・景表法・反社/名義貸し）／紛争予防と証拠保全。",
  "流儀: 契約が絡むときは、契約→支払サイト抽出→経理（紬）へ引き継ぎ→CF予測登録、の線を必ずつなぐ（支払サイトを抽出したら『紬へ引き継ぐ』と明記）。断定的な法的助言は避け、重大案件は弁護士確認を促す。",
  "担当モジュール: 契約リーガル（AIチェック）／イレギュラー案件ボード／役員貸付。",
  "出力: 前置き・JSON・記号装飾は不要。陽翔としての回答本文だけを日本語で返す（1〜4段落程度、要点は箇条書き可）。名乗りは任意。",
].join("\n");

// 事業メモ（専門AIにも共有）— 秘書プロンプトの事業メモと同一の背景知識を注入する
const BIZ_MEMO = [
  "【事業メモ｜パラダイスシティ事業】",
  "内容: 韓国のイベント制作会社『A WORKS』の依頼で、日本のアーティストを韓国のVVIPディナーショーへ出演させる“橋渡し（ブッキング仲介）”事業。",
  "契約構成: A WORKS とは直接契約。①基本契約（枠組み・支払条件・秘密保持・反社排除等）＋②出演契約（公演ごとの出演者・日程・ギャラ・条件）の2本立て。",
  "収支: 売上＝A WORKSからの受注（出演・手配フィー）。仕入原価＝①紹介者への支払＋②所属芸能事務所への支払。粗利＝受注−（紹介者＋事務所）。",
  "支払サイト: 興行前に半金・興行後に半金（前金50%／後金50%）。タイミングは随時変動。前後半金を CF予測 に登録し、A WORKS入金と紹介者・事務所支払のズレ（立替期間）・為替(KRW/JPY)に留意。",
  "【事業メモ｜稲毛海浜公園事業】",
  "指定管理会社＝株式会社ワールドパーク。GoonerはワールドパークとイベントやスポンサーをつけるBの契約。収益＝チケット＋場所代＋スポンサー費。スポンサー費から紹介料20%・製作費30%(変動)を控除し、残利益をワールドパークと折半(50/50)。",
  "【事業メモ｜介護事業・半日デイサービス】",
  "入金: ①国保連の介護給付費（実績月から約2ヶ月遅れ・『〇月分』を必ず記録）②利用者負担金 ③県補助金 ④国補助金。未入金と月分を追う。経費: 固定費／備品／変動費。月次で入金計−経費計＝差引。",
  "【事業メモ｜プロダクト事業】",
  "①RELA（読み：リラ。関係性分析アプリ・App Store非対応でWEB(Stripe)＋Google Play。課金の源はRevenueCat＝月額サブスク¥500/¥1,500/¥3,800＋RELA COIN）②ゆうしゃレオ ③お茶（MARUMAGO・OEM/コンサル）。※「RELA」は必ず『リラ』と読む。",
].join("\n");

const FOCUS_LABEL = { secretary: "凛（首席補佐官）", finance: "紬（経理・CFO）", legal: "陽翔（法務）" };

// ===== RELA プロダクト指標を service_role で読み、円卓の文脈へ注入する要約を作る =====
//   キーはサーバー側のみ（METRICS_RELA_*）。/api/metrics と同じ analytics ビューを読む。
const METRICS_RELA_URL = process.env.METRICS_RELA_URL || "";
const METRICS_RELA_KEY = process.env.METRICS_RELA_SERVICE_KEY || "";
const RELA_DATECOL = { v_daily_funnel: "day", v_utm_funnel: "first_day", v_purchase_breakdown: "day", v_coin_activity: "day" };
// Supabaseキーのヘッダ組み立て。新方式(sb_secret_...)はJWTでないため Authorization Bearer を付けない
// （PostgRESTがJWT検証で401になるのを防ぐ）。旧方式(eyJ...=JWT)は従来どおり Bearer も付ける。
function sbHeaders(key, extra) {
  const h = Object.assign({ apikey: key }, extra || {});
  if (/^eyJ/.test(String(key || ""))) h.Authorization = "Bearer " + key;
  return h;
}
async function readAnalytics(view, fromDate) {
  const dc = RELA_DATECOL[view];
  const url = `${METRICS_RELA_URL}/rest/v1/${view}?select=*&${dc}=gte.${fromDate}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 6000);
  try {
    const r = await fetch(url, {
      headers: sbHeaders(METRICS_RELA_KEY, { "Accept-Profile": "analytics" }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    return await r.json();
  } catch (e) {
    return null;
  } finally {
    clearTimeout(t);
  }
}
function ymd(d) { return d.toISOString().slice(0, 10); }
function sumBy(rows, key) { return (rows || []).reduce((a, r) => a + (Number(r[key]) || 0), 0); }
async function fetchRelaSummary() {
  if (!METRICS_RELA_URL || !METRICS_RELA_KEY) {
    return "【RELAプロダクト指標】現在データ未接続（集計ビュー未作成 または 環境変数 METRICS_RELA_* 未設定）。数値は断らず『指標基盤の設定が完了すれば表示できます』と正直に案内すること。";
  }
  const now = Date.now();
  const from30 = ymd(new Date(now - 30 * 864e5));
  const from7 = ymd(new Date(now - 7 * 864e5));
  const [daily, utm, pur, coin] = await Promise.all([
    readAnalytics("v_daily_funnel", from30),
    readAnalytics("v_utm_funnel", from30),
    readAnalytics("v_purchase_breakdown", from30),
    readAnalytics("v_coin_activity", from30),
  ]);
  if (!daily) {
    return "【RELAプロダクト指標】取得失敗（ビュー未作成の可能性・要 sql/rela_analytics_views.sql 実行）。数値は断らず設定待ちである旨を正直に伝えること。";
  }
  const d7 = daily.filter((r) => String(r.day) >= from7);
  const rate = (a, b) => (b > 0 ? Math.round((a / b) * 100) + "%" : "–");
  const lines = [];
  lines.push("【RELAプロダクト指標（最新・自動連携／読み取り専用）】");
  lines.push("販売: WEB(Stripe)＋Google Play、Apple/App Store非対応。集客: LP(rela.info)・Instagram・TikTok。課金の源はRevenueCat(月額サブスク＋RELA COIN)。");
  lines.push(`■直近7日: 新規${sumBy(d7,"new_users")} / wake ${sumBy(d7,"wake_users")}(Android ${sumBy(d7,"wake_android")}・Web ${sumBy(d7,"wake_web")}) / 分析 ${sumBy(d7,"analysis_users")} / 課金 ${sumBy(d7,"purchase_users")}。wake→分析 ${rate(sumBy(d7,"analysis_users"),sumBy(d7,"wake_users"))}。`);
  lines.push(`■直近30日: 新規${sumBy(daily,"new_users")} / wake ${sumBy(daily,"wake_users")}(Android ${sumBy(daily,"wake_android")}・Web ${sumBy(daily,"wake_web")}) / 分析 ${sumBy(daily,"analysis_users")} / 課金 ${sumBy(daily,"purchase_users")}。`);
  if (Array.isArray(utm) && utm.length) {
    const bySrc = {};
    utm.forEach((r) => { const s = r.source || "direct"; if (!bySrc[s]) bySrc[s] = { u: 0, w: 0, p: 0 }; bySrc[s].u += +r.users || 0; bySrc[s].w += +r.wake_users || 0; bySrc[s].p += +r.purchase_users || 0; });
    const top = Object.keys(bySrc).sort((a, b) => bySrc[b].u - bySrc[a].u).slice(0, 5).map((s) => `${s} 流入${bySrc[s].u}/wake${bySrc[s].w}/課金${bySrc[s].p}`).join(" ／ ");
    lines.push("■流入元(30日): " + top);
  }
  if (Array.isArray(pur) && pur.length) {
    const byP = {};
    pur.forEach((r) => { const p = r.product || "other"; byP[p] = (byP[p] || 0) + (+r.purchases || 0); });
    lines.push("■購入(30日・発生ベース): " + Object.keys(byP).map((p) => `${p} ${byP[p]}件`).join(" / "));
    const PRICE = { premium: 3800, standard: 1500, basic: 500, coins: 300 };
    let rev = 0;
    Object.keys(byP).forEach((p) => { rev += (PRICE[p] || 0) * byP[p]; });
    lines.push("■推定売上(30日・発生ベース概算): ¥" + rev.toLocaleString("ja-JP") + "（プラン単価×件数＋コイン¥300。継続課金/実売上の正はRevenueCat）");
  }
  if (Array.isArray(coin) && coin.length) {
    const grant = sumBy(coin, "welcome_coins") + sumBy(coin, "gift_coins");
    lines.push(`■RELA COIN(近似): 付与${grant} / 購入${sumBy(coin,"bought_coins")} / 分析利用${sumBy(coin,"analyses")}回 / 推定消費${sumBy(coin,"est_consumed_coins")}。残高の正はRevenueCat・課金ゲート現状オフ。`);
  }
  lines.push("注:『DL数』の正確値はGoogle Play Console等ストア側のみ。ここでは新規ユーザー(匿名起動)とwakeを実質的なDL/利用の近似として扱い、その旨を添えて答える。");
  return lines.join("\n");
}

function formatHistoryMessage(m) {
  const content = String(m.content || "").slice(0, 6000);
  if (m.role === "assistant" && m.agent && AGENT_LABEL[m.agent]) {
    return `【${AGENT_LABEL[m.agent]}】${content}`;
  }
  return content;
}

/** OpenAI Chat Completions 用に user/assistant メッセージを整形（画像は vision parts） */
function toOpenAIMessage(m) {
  const role = m.role === "assistant" ? "assistant" : "user";
  if (role === "assistant") {
    return { role, content: formatHistoryMessage(m) };
  }

  const atts = Array.isArray(m.attachments) ? m.attachments : [];
  const images = atts.filter((a) => a && a.kind === "image" && a.dataUrl).slice(0, 4);
  const pdfBlocks = atts
    .filter((a) => a && a.kind === "pdf")
    .map((a) => {
      const body = String(a.text || "").trim();
      return `【添付PDF: ${String(a.name || "document.pdf")}】${body ? `\n${body.slice(0, 8000)}` : "\n（テキスト抽出なし。ファイル名のみ）"}`;
    })
    .join("\n\n");

  let text = String(m.content || "").trim();
  if (pdfBlocks) text = text ? `${text}\n\n${pdfBlocks}` : pdfBlocks;
  if (!text && images.length) text = "添付の画像（領収書・契約書・スクリーンショット等）を確認し、円卓として対応してください。";
  if (!text) text = "（本文なし）";

  if (!images.length) {
    return { role, content: text.slice(0, 12000) };
  }

  return {
    role,
    content: [
      { type: "text", text: text.slice(0, 8000) },
      ...images.map((img) => ({
        type: "image_url",
        image_url: { url: String(img.dataUrl), detail: "high" },
      })),
    ],
  };
}

const ALLOWED_OPS = new Set(["goto", "locate", "snapshot", "print", "search", "pin", "fill", "tasks", "risk", "assign", "delete", "unassign", "note", ""]);

function parseEntakuActions(j) {
  const list = Array.isArray(j && j.actions) ? j.actions : [];
  return list
    .filter((a) => a && (String(a.title || "").trim() || String(a.op || "").trim()))
    .slice(0, 10)
    .map((a) => {
      const opRaw = String(a.op || "").trim().toLowerCase();
      const op = ALLOWED_OPS.has(opRaw) ? opRaw : "";
      const title =
        String(a.title || "").trim() ||
        ({
          goto: "画面を開く",
          locate: "ボタン位置を案内",
          snapshot: "画面内容をプリント",
          print: "印刷する",
          search: "資料を検索",
          pin: "円卓にショートカット",
          fill: "入力欄を編集",
          tasks: "未完了タスクを確認",
          risk: "リスクを忠告",
          assign: "タスクを指示",
          delete: "タスクを削除",
          unassign: "タスクを削除",
          note: "次の一手",
        }[op] || "次の一手");
      return {
        title: title.slice(0, 200),
        owner: String(a.owner || "").trim().slice(0, 20),
        due: String(a.due || "").trim().slice(0, 40),
        module: String(a.module || "").trim().slice(0, 40),
        op,
        query: String(a.query || "").trim().slice(0, 120),
        scope: String(a.scope || "").trim().slice(0, 20),
        label: String(a.label || "").trim().slice(0, 40),
        field: String(a.field || "").trim().slice(0, 60),
        value: String(a.value || "").trim().slice(0, 500),
        assignee: String(a.assignee || a.to || "").trim().slice(0, 80),
        detail: String(a.detail || "").trim().slice(0, 500),
        taskId: String(a.taskId || a.task_id || a.id || "").trim().slice(0, 80),
      };
    });
}

// agent を id に正規化（gpt-4o-mini等が「凛/紬/陽翔」や役職名で返すことがあるため）
function normAgent(a) {
  const s = String(a || "").trim().toLowerCase();
  if (s === "secretary" || s === "finance" || s === "legal") return s;
  const raw = String(a || "");
  if (/秘書|凛|rin/i.test(raw)) return "secretary";
  if (/経理|紬|tsumugi|tumugi/i.test(raw)) return "finance";
  if (/法務|陽翔|はると|haruto/i.test(raw)) return "legal";
  return "";
}

// 凛が埋め込んだ dispatch（専門AIへの指示）を正規化する。finance/legal のみ・最大2件。
function parseEntakuDispatch(j) {
  const list = Array.isArray(j && j.dispatch) ? j.dispatch : [];
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const agent = normAgent(d && d.agent);
    const prompt = String((d && (d.prompt || d.instruction || d.text)) || "").trim();
    if ((agent !== "finance" && agent !== "legal") || !prompt) continue;
    if (seen.has(agent)) continue; // 同一専門家は1件に集約
    seen.add(agent);
    out.push({ agent, prompt: prompt.slice(0, 4000) });
    if (out.length >= 2) break;
  }
  return out;
}

function parseEntakuReplies(raw) {
  const text = String(raw || "").trim();
  if (!text) return { replies: [{ agent: "secretary", text: "（応答が空でした）" }], actions: [], dispatch: [] };
  try {
    const m = text.match(/\{[\s\S]*\}/);
    const j = JSON.parse(m ? m[0] : text);
    const replies = Array.isArray(j.replies) ? j.replies : [];
    const valid = replies
      .map((r) => ({ agent: normAgent(r && r.agent), text: String((r && r.text) || "").trim() }))
      .filter((r) => r.agent && r.text)
      .map((r) => ({ agent: r.agent, text: r.text.slice(0, 6000) }));
    const dispatch = parseEntakuDispatch(j);
    if (valid.length || dispatch.length) {
      // 凛の発言が無い（=dispatchのみ）ときも、先頭に凛の一言を保証する
      const repliesOut = valid.length ? valid : [{ agent: "secretary", text: "担当より確認いたします。" }];
      return { replies: repliesOut, actions: parseEntakuActions(j), dispatch };
    }
  } catch (e) { /* fall through */ }
  return { replies: [{ agent: "secretary", text: text.slice(0, 6000) }], actions: [], dispatch: [] };
}

// 凛の指示プロンプトを受けて、専門家AI（紬=経理／陽翔=法務）を実際に別モデルで呼び出す。
// 返り値は {agent, text} のプレーン発言。失敗しても会議を止めないよう、必ず {agent, text} を返す。
async function callSpecialist(apiKey, agent, prompt, historyMessages, context, relaBlock) {
  const persona = agent === "finance" ? SYSTEM_FINANCE : SYSTEM_LEGAL;
  const sys = [
    persona,
    BIZ_MEMO,
    context ? `【現在のシステム状況】\n${String(context).slice(0, 4000)}` : "",
    agent === "finance" && relaBlock ? relaBlock : "",
  ].filter(Boolean).join("\n\n");
  const directive = {
    role: "user",
    content: `【凛（首席補佐官）からの指示】\n${prompt}\n\n上記の指示に従い、${AGENT_NAME[agent]}（${AGENT_TITLE[agent]}）として社長へ直接お答えください。前置き・JSONは不要、回答本文のみ。`,
  };
  const msgs = [{ role: "system", content: sys }, ...historyMessages, directive];
  const model = AGENT_MODEL[agent];
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), OPENAI_TIMEOUT_MS);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, max_tokens: 1400, temperature: 0.45, messages: msgs }),
      signal: ac.signal,
    });
    if (!r.ok) return { agent, text: `（${AGENT_NAME[agent]}の応答を取得できませんでした）` };
    const data = await r.json();
    const txt = String(data.choices?.[0]?.message?.content || "").trim();
    return { agent, text: txt.slice(0, 6000) || `（${AGENT_NAME[agent]}の応答が空でした）` };
  } catch (e) {
    return { agent, text: `（${AGENT_NAME[agent]}が時間内に応答しませんでした）` };
  } finally {
    clearTimeout(timer);
  }
}

// dispatch を実行して専門家の発言配列を返す（複数はモデル並列呼び出し）。
async function runDispatch(apiKey, dispatch, historyMessages, context, relaBlock) {
  if (!dispatch || !dispatch.length) return [];
  const results = await Promise.all(
    dispatch.map((d) => callSpecialist(apiKey, d.agent, d.prompt, historyMessages, context, relaBlock))
  );
  return results.filter((r) => r && r.text);
}

// 秘書の発言に、dispatch した専門家の発言をマージする。
// dispatch した専門家は別AIの出力で置き換えるため、凛がインラインで代弁した同種発言は落とす。
function mergeEntakuReplies(secReplies, dispatch, specialistReplies) {
  const dispatched = new Set((dispatch || []).map((d) => d.agent));
  const base = (secReplies || []).filter((r) => r.agent === "secretary" || !dispatched.has(r.agent));
  return base.concat(specialistReplies || []);
}

function applyCors(req, res) {
  const origin = String(req.headers.origin || "");
  const allowed =
    !origin ||
    /vercel\.app$/i.test(origin) ||
    origin === "https://hmiyamagooner-collab.github.io" ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin);
  if (allowed) {
    res.setHeader("Access-Control-Allow-Origin", origin || "*");
    res.setHeader("Vary", "Origin");
  }
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
}

function classifyOpenAIError(status, rawText) {
  const t = String(rawText || "");
  let parsed = null;
  try { parsed = JSON.parse(t); } catch (e) { /* ignore */ }
  const code = String(parsed?.error?.code || "");
  const msg = String(parsed?.error?.message || t).slice(0, 400);
  const type = String(parsed?.error?.type || "");
  if (
    code === "credit_balance_exhausted" ||
    code === "insufficient_quota" ||
    type === "insufficient_quota" ||
    /no credits remaining|credit_balance_exhausted|insufficient_quota|billing/i.test(msg)
  ) {
    return {
      state: "no_credits",
      label: "残高不足",
      detail: "OpenAIのクレジット残高がありません。Billingでチャージしてください。",
      code: code || "insufficient_quota",
    };
  }
  if (status === 401 || code === "invalid_api_key" || /invalid.?api.?key/i.test(msg)) {
    return {
      state: "bad_key",
      label: "キー無効",
      detail: "OPENAI_API_KEY が無効です。Vercelの環境変数を確認してください。",
      code: code || "invalid_api_key",
    };
  }
  if (status === 429 || code === "rate_limit_exceeded") {
    return {
      state: "rate_limit",
      label: "レート制限",
      detail: "一時的にリクエスト上限です。しばらく待って再試行してください。",
      code: code || "rate_limit_exceeded",
    };
  }
  return {
    state: "error",
    label: "接続エラー",
    detail: msg || ("HTTP " + status),
    code: code || ("http_" + status),
  };
}

async function fetchRecentSpendUsd(adminKey) {
  if (!adminKey) return null;
  const now = Math.floor(Date.now() / 1000);
  const start = now - 7 * 24 * 3600;
  try {
    const url =
      "https://api.openai.com/v1/organization/costs?start_time=" +
      start +
      "&limit=14";
    const r = await fetch(url, {
      headers: { Authorization: "Bearer " + adminKey },
    });
    const t = await r.text();
    if (!r.ok) return { available: false, reason: "admin_costs_" + r.status };
    let data = {};
    try { data = JSON.parse(t); } catch (e) { return { available: false, reason: "bad_json" }; }
    let total = 0;
    const buckets = Array.isArray(data.data) ? data.data : [];
    for (const b of buckets) {
      const results = Array.isArray(b.results) ? b.results : [];
      for (const row of results) {
        const amt = Number(row?.amount?.value);
        if (Number.isFinite(amt)) total += amt;
      }
    }
    return {
      available: true,
      days: 7,
      usd: Math.round(total * 100) / 100,
      currency: "USD",
    };
  } catch (e) {
    return { available: false, reason: String((e && e.message) || e).slice(0, 120) };
  }
}

async function handleOpenAIStatus(res) {
  const billingUrl = "https://platform.openai.com/settings/organization/billing/";
  const apiKey = await getOpenAIKey();
  if (!apiKey) {
    return res.status(200).json({
      ok: false,
      state: "no_key",
      label: "キー未設定",
      detail: "Vercelの OPENAI_API_KEY が未設定です。",
      billingUrl,
      at: new Date().toISOString(),
    });
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), 12000);
  let probe;
  try {
    // 残高の数値は公式APIに無いため、軽量な models 一覧で「使えるか／残高切れか」を判定する
    probe = await fetch("https://api.openai.com/v1/models", {
      method: "GET",
      headers: { Authorization: "Bearer " + apiKey },
      signal: ac.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && e.name === "AbortError";
    return res.status(200).json({
      ok: false,
      state: aborted ? "timeout" : "error",
      label: aborted ? "応答なし" : "接続エラー",
      detail: aborted ? "OpenAIへの確認がタイムアウトしました。" : String((e && e.message) || e).slice(0, 200),
      billingUrl,
      at: new Date().toISOString(),
    });
  }
  clearTimeout(timer);

  const raw = await probe.text().catch(() => "");
  if (!probe.ok) {
    const cls = classifyOpenAIError(probe.status, raw);
    return res.status(200).json({
      ok: false,
      state: cls.state,
      label: cls.label,
      detail: cls.detail,
      code: cls.code,
      http: probe.status,
      billingUrl,
      at: new Date().toISOString(),
    });
  }

  const adminKey = String(process.env.OPENAI_ADMIN_KEY || "").trim();
  const spend = await fetchRecentSpendUsd(adminKey);

  // 信号機: 残あり=ok(緑)。閾値(OPENAI_ALERT_USD)を超えたら low(橙)。残高切れ/無効は out(赤)は上位のstateで判定。
  let level = "ok";
  const thr = Number(process.env.OPENAI_ALERT_USD || 0);
  if (thr > 0 && spend && spend.available && Number(spend.usd) >= thr) level = "low";

  return res.status(200).json({
    ok: true,
    state: "ok",
    level,
    label: "接続OK",
    detail: "OpenAIに接続でき、残高不足ではありません。",
    model: MODEL,
    spend7d: spend,
    note: "※OpenAIは残り残高の金額を公式APIで返しません。残高不足かどうかはここで確認できます。",
    billingUrl,
    at: new Date().toISOString(),
  });
}

export default async function handler(req, res) {
  applyCors(req, res);
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }
  if (req.method !== "POST") {
    return res.status(405).json({ error: "Method not allowed" });
  }

  try {
    const body = req.body || {};

    // ===== 状態確認（残高不足・キー・接続）=====
    if (body.mode === "status" || body.mode === "health") {
      return await handleOpenAIStatus(res);
    }

    const apiKey = await getOpenAIKey();
    if (!apiKey) {
      return res.status(500).json({
        error: "OPENAI_API_KEY is not configured",
        hint: "Vercelの環境変数 OPENAI_API_KEY を設定するか、api/secrets.local.js.example を secrets.local.js にコピーしてキーを入れてください。",
      });
    }

    // ===== Text-to-Speech（円卓AIの声）=====
    // /api/tts が未デプロイでも動くよう、既存の /api/openai に載せる
    if (body.mode === "tts" || body.tts === true) {
      // gpt-4o-mini-tts は全11声＋トーン指定(instructions)対応。かわいい女性系: coral/nova/sage/shimmer 等。
      const VOICES = new Set([
        "alloy", "ash", "ballad", "coral", "echo", "fable",
        "nova", "onyx", "sage", "shimmer", "verse",
      ]);
      let text = String(body.text || body.input || "").replace(/\s+/g, " ").trim();
      if (!text) return res.status(400).json({ error: "text が空です" });
      if (text.length > 3500) text = text.slice(0, 3500);
      let voice = String(body.voice || body.agent || "nova").toLowerCase();
      if (voice === "secretary" || voice === "rin" || voice === "凛") voice = "nova";
      else if (voice === "finance" || voice === "tsumugi" || voice === "紬") voice = "shimmer";
      else if (voice === "legal" || voice === "hinata" || voice === "陽翔") voice = "onyx";
      if (!VOICES.has(voice)) voice = "nova";
      const speed = Math.min(1.25, Math.max(0.85, Number(body.speed) || 1.05));
      const ttsModel = process.env.OPENAI_TTS_MODEL || "gpt-4o-mini-tts";
      // トーン指定は gpt-4o-mini-tts 系のみ有効（tts-1 は無視される）
      let instructions = String(body.instructions || "").slice(0, 500).trim();
      const supportsInstr = /gpt-4o.*tts/i.test(ttsModel);
      const payload = {
        model: ttsModel,
        voice,
        input: text,
        response_format: "mp3",
        speed,
      };
      if (supportsInstr && instructions) payload.instructions = instructions;
      const acTts = new AbortController();
      const timerTts = setTimeout(() => acTts.abort(), 28000);
      let ttsRes;
      try {
        ttsRes = await fetch("https://api.openai.com/v1/audio/speech", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify(payload),
          signal: acTts.signal,
        });
      } finally {
        clearTimeout(timerTts);
      }
      if (!ttsRes.ok) {
        const t = await ttsRes.text();
        return res.status(502).json({ error: "TTS呼び出しに失敗しました", detail: t.slice(0, 400) });
      }
      const buf = Buffer.from(await ttsRes.arrayBuffer());
      return res.status(200).json({
        ok: true,
        mime: "audio/mpeg",
        audioBase64: buf.toString("base64"),
        voice,
        model: ttsModel,
        chars: text.length,
        at: new Date().toISOString(),
      });
    }

    const history = Array.isArray(body.messages) ? body.messages : [];
    const context = typeof body.context === "string" ? body.context : "";
    const entaku = body.mode === "entaku";
    const focus = ["secretary", "finance", "legal"].includes(body.focus) ? body.focus : "";
    if (!history.length) {
      return res.status(400).json({ error: "messages が空です" });
    }

    // 応答を速めるため送信する履歴を直近12件に抑える（入力トークン＝処理時間の削減）
    const messages = history.slice(-12).map((m) => toOpenAIMessage(m));

    let baseSystem = entaku ? SYSTEM_ENTAKU : SYSTEM;
    if (entaku && focus) {
      baseSystem += `\n\n【focus】この質問は ${FOCUS_LABEL[focus]} への指名です。${FOCUS_LABEL[focus]} を主役に、その人物が最初に答えてください。他の2名は必要なときだけ短く補足します。`;
    }
    // 円卓のときは RELA プロダクト指標をサーバー側で取得し、文脈末尾へ注入（AIが数値で答えられる）
    let relaBlock = "";
    if (entaku) {
      try { relaBlock = await fetchRelaSummary(); } catch (e) { relaBlock = ""; }
    }
    // 現在状況コンテキストも 5000 字までに圧縮（巨大な状況メモによる遅延を抑える）
    const system = [
      baseSystem,
      context ? `【現在のシステム状況】\n${context.slice(0, 5000)}` : "",
      relaBlock,
    ].filter(Boolean).join("\n\n");

    // ===== ストリーミング（円卓のみ・体感速度改善）=====
    // body.stream===true のときだけ SSE で逐次配信。既存の非ストリーミング経路は不変。
    // 失敗してもクライアントは非ストリーミングへフォールバックする設計。
    if (entaku && body.stream === true) {
      res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
      res.setHeader("Cache-Control", "no-cache, no-transform");
      res.setHeader("Connection", "keep-alive");
      const sse = (obj) => {
        try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (e) {}
      };
      const acS = new AbortController();
      const timerS = setTimeout(() => acS.abort(), OPENAI_TIMEOUT_MS);
      let full = "";
      try {
        const upstream = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({
            model: ENTAKU_MODEL,
            max_tokens: 2200,
            temperature: 0.5,
            response_format: { type: "json_object" },
            stream: true,
            messages: [{ role: "system", content: system }, ...messages],
          }),
          signal: acS.signal,
        });
        if (!upstream.ok || !upstream.body) {
          const t = await upstream.text().catch(() => "");
          sse({ error: "OpenAI " + upstream.status, detail: t.slice(0, 300) });
          sse("[DONE]"); clearTimeout(timerS); return res.end();
        }
        const reader = upstream.body.getReader();
        const decoder = new TextDecoder();
        let buf = "";
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let nl;
          while ((nl = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (payload === "[DONE]") continue;
            try {
              const j = JSON.parse(payload);
              const delta = j.choices?.[0]?.delta?.content || "";
              if (delta) { full += delta; sse({ delta }); }
            } catch (e) { /* keepalive / partial */ }
          }
        }
        clearTimeout(timerS);
        const parsed = parseEntakuReplies(full);
        let finalReplies = parsed.replies;
        if (parsed.dispatch && parsed.dispatch.length) {
          try {
            const specialists = await runDispatch(apiKey, parsed.dispatch, messages, context, relaBlock);
            finalReplies = mergeEntakuReplies(parsed.replies, parsed.dispatch, specialists);
          } catch (eD) { /* 専門家呼び出し失敗時は凛の発言のみ返す */ }
        }
        sse({ done: true, replies: finalReplies, actions: parsed.actions });
        res.write("data: [DONE]\n\n");
        return res.end();
      } catch (e) {
        clearTimeout(timerS);
        // ここまでに full があれば救済して返す
        try {
          if (full && full.trim()) {
            const parsed = parseEntakuReplies(full);
            sse({ done: true, replies: parsed.replies, actions: parsed.actions });
          } else {
            sse({ error: (e && e.name === "AbortError") ? "timeout" : String((e && e.message) || e).slice(0, 200) });
          }
        } catch (e2) {}
        try { res.write("data: [DONE]\n\n"); } catch (e3) {}
        return res.end();
      }
    }

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
          model: entaku ? ENTAKU_MODEL : MODEL,
          max_tokens: entaku ? 2200 : 1500,
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
      const cls = classifyOpenAIError(aiRes.status, t);
      if (cls.state === "no_credits") {
        return res.status(502).json({
          error: "OpenAIの残高が不足しています",
          detail: cls.detail,
          state: cls.state,
          billingUrl: "https://platform.openai.com/settings/organization/billing/",
        });
      }
      return res.status(502).json({ error: "OpenAI呼び出しに失敗しました", detail: t.slice(0, 500), state: cls.state });
    }

    const data = await aiRes.json();
    const raw = String(data.choices?.[0]?.message?.content || "").trim();
    if (entaku) {
      const parsed = parseEntakuReplies(raw);
      let replies = parsed.replies;
      const actions = parsed.actions;
      if (parsed.dispatch && parsed.dispatch.length) {
        const specialists = await runDispatch(apiKey, parsed.dispatch, messages, context, relaBlock);
        replies = mergeEntakuReplies(parsed.replies, parsed.dispatch, specialists);
      }
      const text = replies.map((r) => `【${AGENT_LABEL[r.agent]}】${r.text}`).join("\n\n");
      return res.status(200).json({ ok: true, text, replies, actions, dispatch: parsed.dispatch, model: ENTAKU_MODEL, at: new Date().toISOString() });
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
