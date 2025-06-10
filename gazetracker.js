// ============ CONFIG =============
const LOG_EXPIRY_MS = 30 * 1000;

const DEFAULT_LOG_STRUCTURES = {
  examLogs: {
    fullscreen: [],
    keyboard: [],
    multitab: [],
    fullscreenWarnings: [],
    devtools: [],
    focus: [],
    questionTiming: []
  },
  gazeLogs: {
    cameraAccess: [],
    gaze: []
  }
};

// ============ HELPERS ============
function cleanOldLogs(logs) {
  const cleaned = {};
  const now = new Date();
  for (const key in logs) {
    const arr = Array.isArray(logs[key]) ? logs[key] : [];
    cleaned[key] = arr.filter(entry => {
      const ts = entry.timestamp ? new Date(entry.timestamp) : null;
      return ts && (now - ts) < LOG_EXPIRY_MS;
    });
  }
  return cleaned;
}

// ============ LOGGING CORE ============
function loadLogs(type) {
  const stored = JSON.parse(localStorage.getItem(type)) || {};
  const cleaned = cleanOldLogs({ ...DEFAULT_LOG_STRUCTURES[type], ...stored });
  window[type] = cleaned;
  localStorage.setItem(type, JSON.stringify(cleaned));
}

function logEvent(type, subType, message, data = {}) {
  const now = new Date();
  const logObj = {
    timestamp: now.toISOString(),
    message,
    ...data
  };

  if (!window[type][subType]) window[type][subType] = [];
  window[type][subType].push(logObj);
  console.log(`[${subType}] ${message}`, data);

  const cleaned = cleanOldLogs(window[type]);
  localStorage.setItem(type, JSON.stringify(cleaned));
  window[type] = cleaned;
}

function all_logs() {
  window.unifiedExamReport = {
    examEvents: window.examLogs || {},
    gazeEvents: window.gazeLogs || {}
  };
  return window.unifiedExamReport;
}

loadLogs("examLogs");
loadLogs("gazeLogs");

// ============ GAZE TRACKING =============
// Using EXACT logic from gt.js

const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;

const BUFFER_SIZE = 3; // Speeds up responsiveness to center
const directionBuffer = [];

const DIRECTION_ICONS = {
  center: "✅ Looking Center",
  up:     "👆 Looking Up",
  down:   "👇 Looking Down",
  left:   "👈 Looking Left",
  right:  "👉 Looking Right",
  unknown:"❓ Unknown",
};

// Use extended sets of landmarks for better eye box calculation
const LEFT_EYE_POINTS  = [33, 133, 159, 145, 160, 144, 153, 154];
const RIGHT_EYE_POINTS = [362, 263, 386, 374, 387, 373, 380, 381];

// Iris landmark indices
const LEFT_IRIS = 468;
const RIGHT_IRIS = 473;

const THRESHOLD_IRIS_POS    = 0.23;  // forgiving margin around center (tweak if needed)
const HEAD_TURN_THRESHOLD  = 0.08; // tolerate a bit of yaw

function clamp(v, min=0, max=1) {
  return Math.min(max, Math.max(min, v));
}

function getEyeBox(landmarks, indices) {
  const xs = indices.map(i => landmarks[i].x);
  const ys = indices.map(i => landmarks[i].y);
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys)
  };
}

function getNormalizedIrisPos(iris, eyeBox) {
  return {
    x: clamp((iris.x - eyeBox.left) / eyeBox.width),
    y: clamp((iris.y - eyeBox.top) / eyeBox.height)
  };
}

function isHeadTurned(noseTip, eyeCenter) {
  return Math.abs(noseTip.x - eyeCenter.x) > HEAD_TURN_THRESHOLD;
}

function detectGazeDirectionByIrisPos(leftIrisPos, rightIrisPos) {
  const avgX = (leftIrisPos.x + rightIrisPos.x) / 2;
  const avgY = (leftIrisPos.y + rightIrisPos.y) / 2;
  const xOff = avgX - 0.5;
  const yOff = avgY - 0.5;
  const m = THRESHOLD_IRIS_POS;

  if (Math.abs(xOff) < m && Math.abs(yOff) < m) return "center";
  if (yOff < -m) return "up";
  if (yOff >  m) return "down";
  if (xOff < -m) return "left";
  if (xOff >  m) return "right";
  return "unknown";
}

function smoothDirection() {
  if (directionBuffer.length < BUFFER_SIZE) return "unknown";
  const counts = {};
  directionBuffer.forEach(dir => counts[dir] = (counts[dir]||0) + 1);
  return Object.entries(counts).reduce((a, b) => a[1]>b[1]?a:b)[0];
}

async function startGazeTracking(useFakeVideo = false) {
  try {
    let video;

    if (useFakeVideo) {
      video = document.createElement("video");
      video.src = "gaze-tracking-sample.mp4";
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      document.body.appendChild(video);
      video.style.display = "none";  // Hide video from UI
      await video.play();
      logEvent("gazeLogs", "cameraAccess", "Fake video loaded");
    } else {
      
      
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: FRAME_WIDTH, min: 160, max: 480 },     // flexible between 160 and 480, ideally 320
          height: { ideal: FRAME_HEIGHT, min: 120, max: 360 },    // flexible height range
          frameRate: { ideal: 15, min: 10, max: 24 },    // low-medium fps to balance smoothness & perf
          facingMode: "user"                             // front camera if on mobile devices
        },
        audio: false
      });
      video = document.createElement("video");
      video.srcObject = stream;
      video.autoplay = true;
      video.muted = true;
      document.body.appendChild(video);
      video.style.display = "none";  // Hide video from UI
      await video.play();
      logEvent("gazeLogs", "cameraAccess", "Camera access granted");
    }


    const faceMeshModule = await import("https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh");
    const FaceMesh = faceMeshModule.FaceMesh || window.FaceMesh;
    const facemesh = new FaceMesh({
      locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
    });

    facemesh.setOptions({
      maxNumFaces: 1,
      refineLandmarks: true,
      minDetectionConfidence: 0.7,
      minTrackingConfidence: 0.7
    });

    let latestLandmarks = null;
    facemesh.onResults(({ multiFaceLandmarks }) => {
      latestLandmarks = multiFaceLandmarks?.[0] || null;
    });

    const camMod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
    const Camera = camMod.Camera || window.Camera;

    if (!useFakeVideo) {
      const camera = new Camera(video, {
        onFrame: async () => { await facemesh.send({ image: video }); },
        width: FRAME_WIDTH,
        height: FRAME_HEIGHT
      });
      camera.start();
      document.addEventListener("visibilitychange", () => {
        document.hidden ? camera.stop() : camera.start();
      });
    } else {
      (async function loop() {
        await facemesh.send({ image: video });
        requestAnimationFrame(loop);
      })();
    }

    directionBuffer.length = 0;
    const LOG_INTERVAL = 1000, COOLDOWN_MS = 5000;
    let lastLogTime = 0, directionCooldown = {};

    async function processFrame() {
      const now = Date.now();
      let dir = "unknown";

      if (latestLandmarks) {
        const lm = latestLandmarks;

        const leftBox  = getEyeBox(lm, LEFT_EYE_POINTS);
        const rightBox = getEyeBox(lm, RIGHT_EYE_POINTS);

        const leftIris  = getNormalizedIrisPos(lm[LEFT_IRIS], leftBox);
        const rightIris = getNormalizedIrisPos(lm[RIGHT_IRIS], rightBox);

        const eyeCenter = {
          x: (lm[33].x + lm[133].x + lm[362].x + lm[263].x) / 4,
          y: (lm[33].y + lm[133].y + lm[362].y + lm[263].y) / 4
        };

        if (!isHeadTurned(lm[1], eyeCenter)) {
          dir = detectGazeDirectionByIrisPos(leftIris, rightIris);
        }
      }

      directionBuffer.push(dir);
      if (directionBuffer.length > BUFFER_SIZE) directionBuffer.shift();

      const smoothDir = smoothDirection();

      if (
        now - lastLogTime >= LOG_INTERVAL &&
        smoothDir !== "unknown" &&
        (!directionCooldown[smoothDir] || now - directionCooldown[smoothDir] > COOLDOWN_MS)
      ) {
        const msg = smoothDir === "center"
          ? "User is looking at the screen"
          : `User is looking ${smoothDir}`;
        logEvent("gazeLogs", "gaze", msg, { direction: smoothDir });
        directionCooldown[smoothDir] = now;
        lastLogTime = now;
      }

      requestAnimationFrame(processFrame);
    }

    processFrame();

  } catch (e) {
    logEvent("gazeLogs", "cameraAccess", "Camera error", { error: e.message });
    alert("Camera error: " + e.message);
  }
}

// ============ AUTO DOWNLOAD ============
setTimeout(() => {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(all_logs(), null, 2));
  const a = document.createElement('a');
  a.setAttribute("href", dataStr);
  a.setAttribute("download", "unified_exam_report.json");
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  console.log("✅ Download triggered for unifiedExamReport.");
}, 10000);

// ============ INIT ============
startGazeTracking(false);
