let video;
let handLandmarker;
let ready = false;

// 円のスムージング
let sx = 0, sy = 0, sr = 0;
const SMOOTHING = 0.25;
const W = 640, H = 480;

// ===== Audio (Tone.js + p5.sound for確認ビープ) =====
let audioReady = false;
let synth, reverb, chorus;
let isNoteOn = false;
let currentNote = null;
let lastDist = null;
let overlayVisible = true;   // クリック促しオーバーレイ

// p5.sound の確認ビープ
let testOsc, testEnv;

function mousePressed() { startAudio(); }
function touchStarted() { startAudio(); }

function startAudio() {
  if (audioReady || !window.Tone) return;

  Tone.start().then(() => {
    // ストリングス風：鋸波ポリシンセ＋コーラス＋リバーブ
    synth = new Tone.PolySynth(Tone.Synth, {
      oscillator: { type: "sawtooth" },
      envelope: { attack: 0.25, decay: 0.6, sustain: 0.85, release: 1.8 },
      volume: -10
    });
    chorus = new Tone.Chorus(4, 2.5, 0.35).start();
    reverb = new Tone.Reverb({ decay: 3.0, wet: 0.25 });
    synth.chain(chorus, reverb, Tone.Destination);

    // 確認用に p5.sound で短いビープ（Audioが出るかチェック）
    testOsc = new p5.Oscillator('sine');
    testEnv = new p5.Envelope();
    testEnv.setADSR(0.01, 0.1, 0.0, 0.1);
    testEnv.setRange(0.2, 0);
    testOsc.start();
    testOsc.freq(880);
    testOsc.amp(0);
    testEnv.play(testOsc);
    setTimeout(() => testOsc.stop(), 300);

    audioReady = true;
    overlayVisible = false;
    console.log("Audio ready");
  }).catch(err => {
    console.error("Tone.start() failed:", err);
  });
}

function setup() {
  createCanvas(W, H);

  // カメラ
  video = createCapture(VIDEO, onStreamReady);
  video.size(W, H);
  video.hide();

  // MediaPipe読み込みを待って初期化
  waitForMediapipeGlobals().then(initHands).catch(e => {
    console.error("MediaPipeの読み込みに失敗:", e);
  });
}

function onStreamReady() {
  if (video && video.elt) {
    video.elt.muted = true;
    video.elt.playsInline = true;
    video.elt.autoplay = true;
    const p = video.elt.play?.();
    if (p && typeof p.then === "function") p.catch(()=>{});
  }
}

function waitForMediapipeGlobals(timeoutMs = 10000, intervalMs = 100) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const timer = setInterval(() => {
      const ok = typeof window.FilesetResolver !== "undefined" &&
                 typeof window.HandLandmarker  !== "undefined";
      if (ok) { clearInterval(timer); resolve(); return; }
      if (performance.now() - start > timeoutMs) {
        clearInterval(timer); reject(new Error("MediaPipe globals not found within timeout"));
      }
    }, intervalMs);
  });
}

async function initHands() {
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

  // 映像
  if (video && video.elt && video.elt.readyState >= 2) {
    image(video, 0, 0, width, height);
  } else {
    fill(255); text("カメラ待機中… 画面をクリックで音声許可", 10, 20);
    return;
  }

  if (!ready || !handLandmarker) {
    drawOverlay();
    return;
  }

  // 手検出
  const result = handLandmarker.detectForVideo(video.elt, millis());
  const hands = result.landmarks || [];

  if (hands.length === 0) {
    noteOffIfNeeded();
    drawOverlay();
    drawHUD("No hands");
    return;
  }

  const lm = hands[0];
  const th = lm[4]; // 親指先端
  const ix = lm[8]; // 人差し指先端
  if (!th || !ix) {
    noteOffIfNeeded();
    drawHUD("Missing landmarks");
    return;
  }

  // px座標
  const x1 = th.x * width,  y1 = th.y * height;
  const x2 = ix.x * width,  y2 = ix.y * height;

  // 中点＆距離
  const cx = (x1 + x2) * 0.5, cy = (y1 + y2) * 0.5;
  const distPix = Math.hypot(x2 - x1, y2 - y1);

  // 円描画
  const minR = 8, maxR = min(width, height) * 0.4;
  const targetR = constrain(distPix * 0.6, minR, maxR);
  sx = lerp(sx, cx, SMOOTHING);
  sy = lerp(sy, cy, SMOOTHING);
  sr = lerp(sr, targetR, SMOOTHING);

  noFill(); stroke(0,255,0); strokeWeight(4); circle(sx, sy, sr*2);
  noStroke(); fill(0,255,0); circle(x1,y1,8); circle(x2,y2,8);

  // ===== 音のロジック =====
  if (audioReady && synth) {
    // 1) 距離 → 音高（C3〜C5 をスケール量子化）
    const midi = distanceToMidi(distPix, 48, 72);
    const note = Tone.Frequency(midi, "midi").toNote();

    // 2) 距離の変化量 → 音量
    let delta = 0;
    if (lastDist != null) delta = Math.abs(distPix - lastDist);
    lastDist = distPix;
    const vol = map(constrain(delta, 0, 25), 0, 25, -18, -3);

    // 3) しきい値を緩め（ほぼ常時発音）、検出が切れたら止める
    if (!isNoteOn) {
      synth.set({ volume: vol });
      synth.triggerAttack(note);
      isNoteOn = true;
      currentNote = note;
    } else {
      synth.set({ volume: vol });
      if (note !== currentNote) {
        synth.triggerAttack(note, undefined, 1.0);
        currentNote = note;
      }
    }
    drawHUD(`Audio: ON  Note: ${note}  Vol(dB): ${vol.toFixed(1)}`);
  } else {
    drawOverlay();
    drawHUD("Audio: OFF (click canvas)");
  }
}

function noteOffIfNeeded() {
  if (isNoteOn && synth) {
    synth.triggerRelease(currentNote);
    isNoteOn = false;
    currentNote = null;
  }
}

function distanceToMidi(d, low=48, high=72) {
  const clamped = constrain(d, 10, 220);
  const t = (clamped - 10) / (220 - 10); // 0..1
  const raw = low + t * (high - low);

  // Cメジャースケールに量子化
  const scale = [0,2,4,5,7,9,11];
  const n = Math.round(raw);
  const octave = Math.floor(n / 12);
  let deg = n % 12;
  let best = scale[0], minDiff = 99;
  for (const s of scale) {
    const diff = Math.abs(deg - s);
    if (diff < minDiff) { minDiff = diff; best = s; }
  }
  return octave * 12 + best;
}

function drawOverlay() {
  if (!overlayVisible) return;
  push();
  fill(0, 0, 0, 150);
  rect(0, 0, width, height);
  fill(255);
  textAlign(CENTER, CENTER);
  textSize(18);
  text("クリック / タップで音を有効化", width/2, height/2);
  pop();
}

function drawHUD(msg) {
  push();
  fill(255);
  noStroke();
  textSize(12);
  text(msg, 10, 20);
  pop();
}

