// ============ CONFIG =============
const LOG_EXPIRY_MS = 30 * 1000; // 30 seconds (for test purpose)

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

// ============ LOGGING CORE =============
function loadLogs(type) {
  const stored = JSON.parse(localStorage.getItem(type)) || {};
  const cleaned = {};
  const now = new Date();

  Object.keys(DEFAULT_LOG_STRUCTURES[type]).forEach(key => {
    const arr = Array.isArray(stored[key]) ? stored[key] : [];
    cleaned[key] = arr.filter(entry => {
      const ts = entry.timestamp ? new Date(entry.timestamp) : null;
      return ts && (now - ts) < LOG_EXPIRY_MS;
    });
  });

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

  const cleaned = {};
  Object.keys(window[type]).forEach(key => {
    const arr = Array.isArray(window[type][key]) ? window[type][key] : [];
    cleaned[key] = arr.filter(entry => {
      const ts = entry.timestamp ? new Date(entry.timestamp) : null;
      return ts && (now - ts) < LOG_EXPIRY_MS;
    });
  });

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

// ============ GAZE TRACKING (UPDATED) =============
const FRAME_WIDTH = 320;
const FRAME_HEIGHT = 240;
const BUFFER_SIZE = 15;
const directionBuffer = [];
const LEFT_EYE_LANDMARKS = [33, 133, 159, 145];
const RIGHT_EYE_LANDMARKS = [362, 263, 386, 374];
const THRESHOLD_IRIS_POS = 0.15;
const HEAD_TURN_THRESHOLD = 0.05;

function smoothDirection() {
  if (directionBuffer.length < BUFFER_SIZE) return "unknown";
  const counts = {};
  directionBuffer.forEach(dir => counts[dir] = (counts[dir] || 0) + 1);
  return Object.entries(counts).reduce((a, b) => a[1] > b[1] ? a : b)[0];
}

function getEyeBox(landmarks, indices) {
  return {
    left: landmarks[indices[0]].x,
    right: landmarks[indices[1]].x,
    top: landmarks[indices[2]].y,
    bottom: landmarks[indices[3]].y,
    width: landmarks[indices[1]].x - landmarks[indices[0]].x,
    height: landmarks[indices[3]].y - landmarks[indices[2]].y,
  };
}

function getNormalizedIrisPos(iris, eyeBox) {
  return {
    x: (iris.x - eyeBox.left) / eyeBox.width,
    y: (iris.y - eyeBox.top) / eyeBox.height,
  };
}

function isHeadTurned(noseTip, eyeCenter) {
  const yaw = noseTip.x - eyeCenter.x;
  return Math.abs(yaw) > HEAD_TURN_THRESHOLD;
}

function detectGazeDirectionByIrisPos(leftIrisPos, rightIrisPos) {
  const avgX = (leftIrisPos.x + rightIrisPos.x) / 2;
  const avgY = (leftIrisPos.y + rightIrisPos.y) / 2;
  if (avgY < 0.5 - THRESHOLD_IRIS_POS) return "up";
  if (avgY > 0.5 + THRESHOLD_IRIS_POS) return "down";
  if (avgX < 0.5 - THRESHOLD_IRIS_POS) return "left";
  if (avgX > 0.5 + THRESHOLD_IRIS_POS) return "right";
  return "center";
}

async function loadFaceMesh() {
  await import("https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh");
  const FaceMesh = window.FaceMesh;
  const facemesh = new FaceMesh({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}`
  });
  facemesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7
  });
  return facemesh;
}

async function startGazeTracking(useFakeVideo = false) {
  try {
    let video;

    if (useFakeVideo) {
      video = document.createElement("video");
      video.style.display = "none";
      video.src = "gaze-tracking-sample.mp4";
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      document.body.appendChild(video);
      logEvent("gazeLogs", "cameraAccess", "Fake video loaded");
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 320, min: 160, max: 480 },
          height: { ideal: 240, min: 120, max: 360 },
          frameRate: { ideal: 15, min: 10, max: 24 },
          facingMode: "user"
        },
        audio: false
      });

      video = document.createElement("video");
      video.style.display = "none";
      video.srcObject = stream;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      document.body.appendChild(video);
      logEvent("gazeLogs", "cameraAccess", "Camera access granted");
    }

    const facemesh = await loadFaceMesh();
    let latestLandmarks = null;
    facemesh.onResults(({ multiFaceLandmarks }) => {
      latestLandmarks = multiFaceLandmarks?.[0] || null;
    });

    const directionBuffer = [];
    const BUFFER_SIZE = 5;
    const LOG_INTERVAL = 1000; // 1 second
    const COOLDOWN_MS = 5000;

    let lastLogTime = 0;
    let lastLoggedDirection = null;
    const directionCooldown = {};

    function smoothDirection() {
      const counts = {};
      for (const dir of directionBuffer) {
        counts[dir] = (counts[dir] || 0) + 1;
      }
      return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || "unknown";
    }

    async function processFrame() {
      const now = Date.now();
      let currentDirection = "unknown";

      if (latestLandmarks) {
        const lm = latestLandmarks;
        const leftEyeBox = getEyeBox(lm, LEFT_EYE_LANDMARKS);
        const rightEyeBox = getEyeBox(lm, RIGHT_EYE_LANDMARKS);
        const leftIrisPos = getNormalizedIrisPos(lm[468], leftEyeBox);
        const rightIrisPos = getNormalizedIrisPos(lm[473], rightEyeBox);

        const eyeCenter = {
          x: (lm[33].x + lm[133].x + lm[362].x + lm[263].x) / 4,
          y: (lm[33].y + lm[133].y + lm[362].y + lm[263].y) / 4
        };

        const noseTip = lm[1];
        const turned = isHeadTurned(noseTip, eyeCenter);

        if (!turned) {
          currentDirection = detectGazeDirectionByIrisPos(leftIrisPos, rightIrisPos);
        }
      }

      directionBuffer.push(currentDirection);
      if (directionBuffer.length > BUFFER_SIZE) directionBuffer.shift();

      const smoothDir = smoothDirection();

      if (
        now - lastLogTime >= LOG_INTERVAL &&
        smoothDir !== "unknown" &&
        (!directionCooldown[smoothDir] || now - directionCooldown[smoothDir] > COOLDOWN_MS)
      ) {
        const message = smoothDir === "center"
          ? "User is looking at the screen"
          : "User eyes are not focused on screen";

        const logData = {
          timestamp: new Date().toISOString(),
          direction: smoothDir
        };

        logEvent("gazeLogs", "gaze", message, logData);
        directionCooldown[smoothDir] = now;
        lastLogTime = now;
        lastLoggedDirection = smoothDir;
      }

      requestAnimationFrame(processFrame);
    }

    if (!useFakeVideo) {
      const { Camera } = await import("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
      const camera = new Camera(video, {
        onFrame: async () => {
          await facemesh.send({ image: video });
        },
        width: 320,
        height: 240
      });
      camera.start();

      document.addEventListener("visibilitychange", () => {
        if (document.hidden) camera.stop();
        else camera.start();
      });
    } else {
      async function loop() {
        await facemesh.send({ image: video });
        requestAnimationFrame(loop);
      }
      loop();
    }

    processFrame();
  } catch (e) {
    logEvent("gazeLogs", "cameraAccess", "Camera error", { error: e.message });
    alert("Camera access is denied ( suspicious )");
  }
}

// ============ AUTO DOWNLOAD TEST =============
setTimeout(() => {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(all_logs(), null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", "unified_exam_report.json");
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  document.body.removeChild(downloadAnchor);
  console.log("✅ Download triggered for unifiedExamReport.");
}, 25000);

// ============ START TRACKING ============
startGazeTracking(false);
