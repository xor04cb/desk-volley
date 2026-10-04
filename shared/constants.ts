// 調整用の定数をここに集める。【要確認】【要調整】の値はすべて仮の値。
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
export const JUMP_HEIGHT_MIN = 0.35; // 溜め0のジャンプ高さ 【要調整】
export const JUMP_HEIGHT_MAX = 0.95; // 溜め最大のジャンプ高さ 【要調整】
export const BLOCK_JUMP_MIN = 0.3;
export const BLOCK_JUMP_MAX = 0.8;
export const PLAYER_MIN_NET_DIST = 0.35; // 選手がネットに近づける距離

// ---- 溜め・タイミング ----
export const CHARGE_MAX = 0.6; // 秒。これだけ押すと溜め最大 【要調整】
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
export const JUDGE_WINDOW_TICKS = Math.ceil(JUDGE.BAD * TICK_RATE); // 判定を探す範囲

// ---- 打点（選手の足元からの高さ）と届く距離 ----
export const RECEIVE_HIT_HEIGHT = 0.85;
export const RECEIVE_REACH = 1.3;
export const RECEIVE_REACH_FAST = 0.75; // 速い打球（RECEIVE_FAST_SPEED以上）に届く距離 【要調整】
export const RECEIVE_FAST_SPEED = 17;
export const TOSS_HIT_HEIGHT = 2.2;
export const TOSS_REACH = 1.2;
export const SPIKE_REACH = 1.0; // 手（ジャンプ中の最高到達点付近）からの距離

// ---- レシーブ ----
export const RECEIVE_APEX_MIN = 3.6; // 最高点の高さ
export const RECEIVE_APEX_MAX = 4.6;
export const RECEIVE_SCATTER_MAX = 3.2; // 溜め0・BAD時のぶれ半径(m) 【要調整】
export const RECEIVE_SCATTER_MIN = 0.3; // 溜め最大・PERFECT時のぶれ半径
export const RECEIVE_EASY_SPEED = 9; // これより速い打球はレシーブが乱れる 【要調整】
export const RECEIVE_SPEED_PENALTY = 0.14; // 1m/s速いごとのぶれ倍率の増加
export const SET_TARGET = { lx: 0.6, lz: 1.2 }; // セッターへの返球目標（チームから見た座標）

// ---- トス ----
// ツーアタックは、ボールを打てる位置の近くにいるときだけ。走って追いかけている最中はトスになる（誤操作防止）
export const TWO_ATTACK_MAX_DIST = 1.2; // m 【要調整】
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
export const SPIKE_CHARGE_FLOOR = 0.15; // これ未満はフェイント（ONのとき）
export const SPIKE_TARGET_LZ = 6.0; // 狙いの深さ（相手ネットからの距離）
export const SPIKE_AIM_LX = 3.0; // スティック横倒しでの左右の狙い

// ---- フェイント ----
export const FEINT_MAX_DIST = 3; // ネット際から3m以内
export const FEINT_APEX_ABOVE_NET = 1.2; // ネット上端からの最高点

// ---- サーブ ----
export const SERVE_TIME_LIMIT = 10; // 秒（仮）【要確認】
export const SERVE_BEHIND_END = 1.0; // エンドラインからの距離
export const SERVE_TOSS_HEIGHT = 1.6; // サーブトスで手元からどれだけ上がるか
export const SERVE_HIT_HEIGHT = 2.7;
export const SERVE_APEX_SLOW = 5.2; // 溜め0の最高点（遅い山なり）
export const SERVE_APEX_FAST = 3.3; // 溜め最大の最高点（速い・低い）
export const SERVE_SCATTER_MIN = 0.6;
export const SERVE_SCATTER_MAX = 2.6; // 溜めが大きいほどぶれも大きい（アウトのリスク）
export const SERVE_TARGET_LZ = 6.0;
export const SERVE_AIM_LX = 2.5;

// ---- ブロック ----
export const BLOCK_HAND_BOTTOM = 2.1; // 足元からの高さ（手の下端）
export const BLOCK_HAND_TOP = 2.55; // 足元からの高さ（手の上端）
export const BLOCK_HALF_WIDTH = 0.45;
export const BLOCK_DEPTH = 0.45; // ネットから手が出る奥行き
export const BLOCK_RESTITUTION = 0.45;

// ---- 進行 ----
export const POINT_PAUSE = 1.8; // 得点後スコア表示の秒数
export const LANDING_GRACE_TICKS = 15; // 接地からの得点確定待ち（遅れて離した入力やラグ補償で巻き戻す余地。250ms）
export const HISTORY_TICKS = 30; // ボール・選手の位置を保存するtick数

// ---- AI ----
export const AI = {
  timingSigma: 0.07, // AIの押すタイミングのぶれ（秒）【要調整】
  chargeMin: 0.4,
  chargeMax: 1.0,
  reactionDelay: 0.25, // 相手の打球に反応するまでの秒数
  spikeReactionExtra: 0.12, // スパイクへの反応はさらに遅れる（秒）
  aimSamples: 4, // スパイクの狙いを何案から選ぶか（多いほど空いた所を突く）
  fastBallSigma: 0.1, // 速い打球ほどタイミングがぶれる（1m/sごとの倍率増加）
  speedFactor: 0.95, // 移動速度の倍率
  feintRate: 0.15,
  blockTimingSigma: 0.1,
  blockFollowFeint: 0.5, // フェイントを読んで前に出る確率
};
