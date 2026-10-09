// 調整用の定数をここに集める。【要確認】【要調整】の値はすべて仮の値。
import type { ContactKind } from './types.ts';
// 座標系：x=横（右が+）、y=高さ、z=奥行き。ネットは z=0。チーム0は z>0 側（手前）。1単位=1m。

// ---- ループ ----
export const TICK_RATE = 60;
export const DT = 1 / TICK_RATE;

// ---- コート ----
export const COURT_HALF_WIDTH = 4.5; // 横9m
export const COURT_HALF_LENGTH = 9; // 縦18m
export const NET_HEIGHT = 2.43; // 一般男子
export const NET_POST_OFFSET = 0.5; // サイドラインからポールまで
export const ATTACK_LINE = 3; // ネットからアタックライン

// ---- ボール・物理 ----
export const BALL_RADIUS = 0.11;
export const GRAVITY = 9.8;
export const GRAVITY_SCALE = 0.8; // 【要調整】操作感に合わせる
export const G = GRAVITY * GRAVITY_SCALE;
export const NET_RESTITUTION = 0.3; // ネットに当たったときの跳ね返り
export const FLOOR_BOUNCE = 0.35; // 床での跳ね返り（演出用。得点は最初の接地で確定）

// ---- 選手 ----
export const PLAYER_SPEED = 5.2; // m/s 【要調整】
export const PLAYER_HEIGHT = 1.9;
export const STANDING_REACH = 2.4; // 立った状態で手が届く高さ
export const JUMP_HEIGHT_MIN = 0.5; // 溜め0のジャンプ高さ 【要調整】
export const JUMP_HEIGHT_MAX = 1.25; // 溜め最大のジャンプ高さ 【要調整】
export const BLOCK_JUMP_MIN = 0.45; // 【要調整】
export const BLOCK_JUMP_MAX = 1.05; // 【要調整】
export const PLAYER_MIN_NET_DIST = 0.35; // 選手がネットに近づける距離

// ---- 溜め・タイミング ----
export const CHARGE_MAX = 0.6; // 秒。これだけ押すと溜め最大 【要調整】
/** スパイク（空中の2回目）の溜め最大（秒）。跳んでから打つまで0.36〜0.56秒しかないので短くする 【要調整】 */
export const SPIKE_CHARGE_MAX = 0.3;
export const JUDGE = {
  PERFECT: 0.05, // ±50ms
  GOOD: 0.12, // ±120ms
  BAD: 0.25, // ±250ms
} as const;
export const JUDGE_EFFECT = {
  // charge=溜め効果の割合、scatter=ぶれ半径の倍率、acc=狙いの正確さ（1で最小ぶれ）
  PERFECT: { charge: 1.0, scatter: 0.5, acc: 1.0 },
  GOOD: { charge: 0.7, scatter: 0.75, acc: 0.6 },
  BAD: { charge: 0.3, scatter: 1.0, acc: 0.0 },
} as const;
/** 早めに離したときの猶予（秒）。この分だけ早くても同じ評価になる 【要調整】 */
const EARLY_GRACE_SEC = 0.07;
export const EARLY_GRACE: Partial<Record<ContactKind, number>> = { receive: EARLY_GRACE_SEC, toss: EARLY_GRACE_SEC };
/** 動作ごとの判定幅の倍率（1で上の表どおり）。スパイクは空中で合わせにくいので広げる 【要調整】 */
export const JUDGE_SCALE: Partial<Record<ContactKind, number>> = { spike: 1.5 };
const MAX_JUDGE_SCALE = Math.max(1, ...Object.values(JUDGE_SCALE));
export const JUDGE_WINDOW_TICKS = Math.ceil(Math.max(JUDGE.BAD + EARLY_GRACE_SEC, JUDGE.BAD * MAX_JUDGE_SCALE) * TICK_RATE); // 判定を探す範囲

// ---- 打点（選手の足元からの高さ）と届く距離 ----
export const RECEIVE_HIT_HEIGHT = 0.85;
export const RECEIVE_REACH = 1.3;
export const RECEIVE_REACH_FAST = 0.75; // 速い打球（RECEIVE_FAST_SPEED以上）に届く距離 【要調整】
export const RECEIVE_FAST_SPEED = 17;
export const TOSS_HIT_HEIGHT = 2.2;
export const TOSS_REACH = 1.2;
export const SPIKE_REACH = 1.0; // 手（ジャンプ中の最高到達点付近）からの距離
export const LANDING_MARK_RADIUS = 0.5; // 落下予測円の外径（描画にも使う）
/** スパイクは選手の中心がこの範囲（落下予測円＋体の半分）にあれば、横方向の位置に関わらず打てる。高さは SPIKE_REACH で見る 【要調整】 */
export const SPIKE_FRAME_RADIUS = LANDING_MARK_RADIUS + 0.25;

// ---- レシーブ ----
export const RECEIVE_APEX_MIN = 3.6; // 最高点の高さ
export const RECEIVE_APEX_MAX = 4.6;
export const RECEIVE_RECOVER_TICKS = 24; // カットした選手はこの間（0.4秒）動けない 【要調整】
export const SERVE_RECEIVE_APEX_BONUS = 1.0; // サーブカットはこれだけ高く上げる 【要調整】
export const RECEIVE_SCATTER_MAX = 3.2; // 溜め0・BAD時のぶれ半径(m) 【要調整】
export const RECEIVE_SCATTER_MIN = 0.3; // 溜め最大・PERFECT時のぶれ半径
export const RECEIVE_EASY_SPEED = 9; // これより速い打球はレシーブが乱れる 【要調整】
export const RECEIVE_SPEED_PENALTY = 0.14; // 1m/s速いごとのぶれ倍率の増加
export const SET_TARGET = { lx: 0.6, lz: 1.2 }; // セッターへの返球目標（チームから見た座標）

// ---- トス ----
// ツーアタックは、ボールを打てる位置の近くにいるときだけ。走って追いかけている最中はトスになる（誤操作防止）
export const TWO_ATTACK_MAX_DIST = 1.2; // m 【要調整】
// 2本目はセッターが上げる。ほかの選手よりこの秒数以上遅れるときだけ、ほかの選手が上げる 【要調整】
export const SETTER_PREFER_SEC = 0.5;
// トスの向き（レフト・センター・ライト）は、打点からこの距離以内にいるときだけスティックの左右で選ぶ 【要調整】
export const TOSS_AIM_MAX_DIST = 1.2; // m
export const TOSS_APEX_MIN = 3.6; // 【要調整】
export const TOSS_APEX_MAX = 6.0;
export const TOSS_SCATTER_MAX = 1.6;
export const TOSS_SCATTER_MIN = 0.15;
export const TOSS_TARGET_LZ = 0.9; // アタッカー用トスの落下目標（ネットからの距離）
export const TOSS_TARGET_LX = { left: -3.3, center: 0, right: 3.3 };

// ---- スパイク ----
export const SPIKE_SPEED_MIN = 9; // m/s（水平） 【要調整】
export const SPIKE_SPEED_MAX = 17;
export const SPIKE_SCATTER_MAX = 2.6;
export const SPIKE_SCATTER_MIN = 0.3;
export const FEINT_TAP_SEC = 0.09; // スパイクの2回目をこれより短く押すとフェイント（ONのとき） 【要調整】
export const SPIKE_CHARGE_FLOOR = FEINT_TAP_SEC / SPIKE_CHARGE_MAX; // 溜め量にしたフェイントの境目
export const SPIKE_TARGET_LZ = 6.0; // 狙いの深さ（相手ネットからの距離）
export const SPIKE_AIM_LX = 3.0; // スティック横倒しでの左右の狙い
export const SPIKE_AIM_DEPTH = 2.5; // スティックを上（奥）に倒すと深く、下に倒すと浅くなる量(m)

// ---- フェイント ----
export const FEINT_MAX_DIST = 3; // ネット際から3m以内
export const FEINT_APEX_ABOVE_NET = 1.2; // ネット上端からの最高点

// ---- サーブ ----
export const SERVE_TIME_LIMIT = 10; // 秒（仮）【要確認】
export const SERVE_BEHIND_END = 1.0; // エンドラインからの距離
export const SERVE_TOSS_HEIGHT = 1.6; // サーブトスで手元からどれだけ上がるか
export const SERVE_HIT_HEIGHT = 2.7;
export const SERVE_APEX_SLOW = 4.4; // 溜め0の最高点（遅い山なり）【要調整】
export const SERVE_APEX_FAST = 3.2; // 溜め最大の最高点（速い・低い）【要調整】
export const SERVE_SCATTER_MIN = 0.6;
export const SERVE_SCATTER_MAX = 2.6; // 溜めが大きいほどぶれも大きい（アウトのリスク）
// 狙う深さ（相手ネットから）。速い球は深く狙わないとネットに掛かる 【要調整】
export const SERVE_TARGET_LZ_SLOW = 5.5;
export const SERVE_TARGET_LZ_FAST = 7.5;
export const SERVE_AIM_LX = 2.5;

// ---- ブロック ----
export const BLOCK_HAND_BOTTOM = 2.1; // 足元からの高さ（手の下端）
export const BLOCK_HAND_TOP = 2.55; // 足元からの高さ（手の上端）
export const BLOCK_HALF_WIDTH = 0.45;
export const BLOCK_DEPTH = 0.45; // ネットから手が出る奥行き
export const BLOCK_RESTITUTION = 0.45;
// ワンタッチ：手の上の方・左右の端に当たると勢いが死に、ブロック側のコートへ拾いやすいボールが上がる 【要調整】
export const BLOCK_TOUCH_TOP = 0.32; // 手の上端からこの範囲に当たるとワンタッチ(m)
export const BLOCK_TOUCH_EDGE = 0.25; // 手の左右の端からこの範囲に当たるとワンタッチ(m)
export const BLOCK_TOUCH_APEX_MIN = 3.4; // ワンタッチで上がるボールの最高点
export const BLOCK_TOUCH_APEX_MAX = 4.4;
export const BLOCK_TOUCH_LZ_MIN = 3; // 落ちる深さ（ブロック側のネットから）
export const BLOCK_TOUCH_LZ_MAX = 8;
export const BLOCK_TOUCH_SPREAD = 1.5; // 左右のぶれ(m)。サイドライン近くではコートの外へ出ることもある

// ---- フライング（届かないボールに飛び込むレシーブ） ----
export const DIVE_REACH = 1.4; // 普通に届く距離より、さらにこれだけ遠くまで届く(m) 【要調整】
export const DIVE_REACH_FAST = 0; // 速い打球（RECEIVE_FAST_SPEED以上）のときのフライングの伸び 【要調整】
export const DIVE_SCATTER_MUL = 1.6; // 返球のぶれの倍率（フライングは乱れやすい） 【要調整】
export const DIVE_SLIDE_TICKS = 15; // 飛び込む動きの長さ（0.25秒）
export const DIVE_RECOVER_TICKS = 60; // 飛び込んでから起き上がるまで（1秒）。この間は動けない 【要調整】
export const DIVE_HAND_OFFSET = 0.7; // 飛び込んだ体の位置から手（打点）までの距離
/** 人のフライングは、飛び込んだ手がこの範囲（落下予測円＋余裕）に入らなければ上がらない 【要調整】 */
export const DIVE_FRAME_RADIUS = LANDING_MARK_RADIUS + 0.25;

// ---- レシーブの担当 ----
/** 相手からのボールがネットからこの距離より奥に落ちるときは、後衛がレシーブする 【要調整】 */
export const FRONT_RECEIVE_DEPTH = ATTACK_LINE;

// 相手のスパイク（速い球）は、打点より前（ネット側）にいて後ろへ下がらないと取れない選手には取らせない 【要調整】
export const RECEIVE_BACKSTEP_MAX = 0.5; // 打点がこれ以上後ろにある選手は候補から外す(m)

// サイドからのまっすぐなフェイントは、その側の後衛が取る 【要調整】
export const SIDE_ATTACK_MIN_X = 2.0; // 打った選手がコート中央からこれ以上離れていればサイドからの攻撃(m)
export const STRAIGHT_FEINT_MAX_DX = 1.5; // 落下地点が打った選手の正面からこの範囲ならまっすぐ(m)

// ---- 操作していない選手の位置取りの動き ----
// 打球ごとに陣形の目標が変わっても、全員が全力で走り直さないようにする 【要調整】
export const OFFBALL = {
  reaction: 0.3, // 打球を見てから動き出すまで（秒）。この間は前の目標へ向かい続ける
  accel: 14, // 加速・減速（m/s²）。急に走り出したり向きを変えたりしない
  minPace: 0.45, // 間に合うなら、全力のこの割合までゆっくり動く
  margin: 0.4, // 次にボールが落ちるこの秒数前までに着くように動く
  stopDist: 0.15, // 目標がこれより近ければ止まる（小さなずれで足踏みしない）
  faceRunDist: 2.5, // 目標がこれより遠いときは走る向きを向く。近いときはボールを見たまま動く
};

// ---- 進行 ----
export const POINT_PAUSE = 1.8; // 得点後スコア表示の秒数
export const LANDING_GRACE_TICKS = 15; // 接地からの得点確定待ち（遅れて離した入力やラグ補償で巻き戻す余地。250ms）
export const HISTORY_TICKS = 30; // ボール・選手の位置を保存するtick数

// ---- 練習モード ----
export const PRACTICE = {
  serveDelay: 0.8, // CPUがサーブを打つまで（秒）
  afterTouch: 1.2, // カット・レシーブした後、次の1本までの秒数
  afterAttack: 1.5, // スパイクを打った後、次の1本までの秒数
  afterServe: 2.5, // サーブを打った後、次の1本までの秒数（先に落ちればそちら）
  afterLand: 0.8, // ボールが落ちてから次の1本までの秒数
  passApex: 4.2, // スパイク練習でセッターへ返すパスの最高点
  tossApex: 5.0, // スパイクレシーブ練習で相手が上げるトスの最高点
  tossCharge: 0.6, // 自動トスの溜め量（最高点の高さが決まる）
};

// ---- AI ----
export const AI = {
  timingSigma: 0.07, // AIの押すタイミングのぶれ（秒）【要調整】
  chargeMin: 0.4,
  chargeMax: 1.0,
  // スパイクの溜め量。人は空中で0.2〜0.4秒押せる＝溜め0.67〜1.0なので、それに合わせる 【要調整】
  spikeChargeMin: 0.6,
  spikeChargeMax: 1.0,
  reactionDelay: 0.25, // 相手の打球に反応するまでの秒数
  spikeReactionExtra: 0.12, // スパイクへの反応はさらに遅れる（秒）
  aimSamples: 4, // スパイクの狙いを何案から選ぶか（多いほど空いた所を突く）
  fastBallSigma: 0.1, // 速い打球ほどタイミングがぶれる（1m/sごとの倍率増加）
  speedFactor: 0.95, // 移動速度の倍率
  feintRate: 0.15,
  blockTimingSigma: 0.1,
  blockFollowFeint: 0.5, // フェイントを読んで前に出る確率
  diveRate: 0.5, // フライングで届くボールに飛び込む確率 【要調整】
};
