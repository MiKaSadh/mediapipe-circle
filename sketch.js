let video;
let handLandmarker;
let ready = false;

// スムージング用（予約語衝突回避：SMOOTH → SMOOTHING）
let sx = 0, sy = 0, sr = 0;
const SMOOTHING = 0.25;

const W = 640, H = 480;

function setup() {
  createCanvas(W, H);

  // カメラ
  video = createCapture(VIDEO, onStreamReady);
  video.size(W, H);
  video.hide();

  // MediaPipe のグローバルが出現するまで待ってから初期化
  waitForMediapipeGlobals().then(initHands).catch((e) => {
    console.error("MediaPipeの読み込みに失敗:", e);
  });
}

function onStreamReady() {
  // 自動再生ポリシー対策
  if (video && video.elt) {
    video.elt.muted = true;
    video.elt.playsInline = true;
    video.elt.autoplay = true;
    const p = video.elt.play?.();
    if (p && typeof p.then === "function") p.catch(() => {});
  }
}

/**
 * MediaPipe Tasks Vision のグローバル（FilesetResolver / HandLandmarker）
 * が使えるまでポーリングで待機
 */
function waitForMediapipeGlobals(timeoutMs = 8000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const start = millis ? millis() : performance.now();
    const timer = setInterval(() => {
      const ok =
        typeof globalThis.FilesetResolver !== "undefined" &&
        typeof globalThis.HandLandmarker !== "undefined";
      if (ok) {
        clearInterval(timer);
        resolve();
      } else {
        const now = millis ? millis() : performance.now();
        if (now - start > timeoutMs) {
          clearInterval(timer);
          reject(new Error("MediaPipe globals not found within timeout"));
        }
      }
    }, intervalMs);
  });
}

async function initHands() {
  // globalThis 経由で安全に参照
  const { FilesetResolver, HandLandmarker } = globalThis;

  const vision = await FilesetResolver.forVisionTasks(
    "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision/wasm"
  );

  handLandmarker = await HandLandmarker.createFromOptions(vision, {
    baseOptions: {
      modelAssetPath:
        "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    },
    numHands: 2,
    runningMode: "VIDEO",
    minHandDetectionConfidence: 0.5,
    minHandPresenceConfidence: 0.5,
    minTrackingConfidence: 0.5,
  });

  ready = true;
  console.log("HandLandmarker ready");
}

function draw() {
  background(0);

  // 映像が準備できるまで待つ
  if (video && video.elt && video.elt.readyState >= 2) {
    image(video, 0, 0, width, height);
  } else {
    fill(255);
    textSize(14);
    text("カメラ待機中…（許可/他アプリ占有/デバイス選択を確認）", 10, 20);
    return;
  }

  if (!ready || !handLandmarker) return;

  const res = handLandmarker.detectForVideo(video.elt, millis());
  const hands = res.landmarks || [];
  if (hands.length === 0) return;

  // 片手のみ使用（必要なら両手ループに拡張可）
  const lm = hands[0];
  const th = lm[4]; // 親指先端
  const ix = lm[8]; // 人差し指先端
  if (!th || !ix) return;

  const x1 = th.x * width,  y1 = th.y * height;
  const x2 = ix.x * width,  y2 = ix.y * height;

  const cx = (x1 + x2) * 0.5;
  const cy = (y1 + y2) * 0.5;
  const distPix = Math.hypot(x2 - x1, y2 - y1);

  // 半径は距離に比例（暴れ防止の上下限）
  const minR = 8;
  const maxR = min(width, height) * 0.4;
  const targetR = constrain(distPix * 0.6, minR, maxR);

  // スムージング
  sx = lerp(sx, cx, SMOOTHING);
  sy = lerp(sy, cy, SMOOTHING);
  sr = lerp(sr, targetR, SMOOTHING);

  // 円描画
  noFill();
  stroke(0, 255, 0);
  strokeWeight(4);
  circle(sx, sy, sr * 2);

  // デバッグ用の指先点
  noStroke();
  fill(0, 255, 0);
  circle(x1, y1, 8);
  circle(x2, y2, 8);

  // 距離表示
  fill(255);
  noStroke();
  textSize(12);
  text(`distance: ${distPix.toFixed(1)} px`, 10, 20);
}
