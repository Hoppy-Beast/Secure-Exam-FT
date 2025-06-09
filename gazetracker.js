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
  const now = Date.now();

  Object.keys(DEFAULT_LOG_STRUCTURES[type]).forEach(key => {
    const arr = Array.isArray(stored[key]) ? stored[key] : [];
    cleaned[key] = arr.filter(entry => now - (entry.timestamp || 0) < LOG_EXPIRY_MS);
  });

  window[type] = cleaned;
  localStorage.setItem(type, JSON.stringify(cleaned));
}

function logEvent(type, subType, message, data = {}) {
  const logObj = {
    timestamp: Date.now(),
    message,
    ...data
  };

  if (!window[type][subType]) window[type][subType] = [];
  window[type][subType].push(logObj);
  console.log(`[${subType}] ${message}`, data);

  const now = Date.now();
  const cleaned = {};
  Object.keys(window[type]).forEach(key => {
    const arr = Array.isArray(window[type][key]) ? window[type][key] : [];
    cleaned[key] = arr.filter(entry => now - (entry.timestamp || 0) < LOG_EXPIRY_MS);
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

// ============ GAZE TRACKING =============
const focusStats = {
  focused: 0,
  notFocused: 0,
  total: 0
};

function updateFocusStats(isFocused) {
  if (isFocused) focusStats.focused++;
  else focusStats.notFocused++;
  focusStats.total++;
}

let lastFocusLogTime = 0;
function printFocusStats() {
  const now = Date.now();
  if (focusStats.total === 0) return;
  const print_interval_seconds = 10;
  // Only print every 10 seconds
  if (now - lastFocusLogTime < print_interval_seconds * 1000) return;
  
  lastFocusLogTime = now;
  const focusedPercent = ((focusStats.focused / focusStats.total) * 100).toFixed(1);
  const notFocusedPercent = ((focusStats.notFocused / focusStats.total) * 100).toFixed(1);
  console.log(`📊 Focus Stats: Focused: ${focusedPercent}%, Not Focused: ${notFocusedPercent}%`);
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

async function startGazeTracking(useFakeVideo = false, video_width = 320, video_height = 240) {
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
      logEvent("gazeLogs", "cameraAccess", "Fake video loaded for gaze tracking");
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

    setInterval(() => {
      const now = Date.now();

      if (!latestLandmarks) {
        updateFocusStats(false);
        logEvent("gazeLogs", "gaze", "No face detected (user might be away or out of frame)");
        printFocusStats();
        return;
      }

      const lm = latestLandmarks;
      const leftEyeOuter = lm[33];
      const leftEyeInner = lm[133];
      const rightEyeInner = lm[362];
      const rightEyeOuter = lm[263];
      const noseTip = lm[1];
      const leftIris = lm[468];

      const eyeWidth = leftEyeInner.x - leftEyeOuter.x;
      if (eyeWidth <= 0) {
        updateFocusStats(false);
        logEvent("gazeLogs", "gaze", "Invalid eye width detected (possible tracking error)");
        printFocusStats();
        return;
      }


      const irisPos = (leftIris.x - leftEyeOuter.x) / eyeWidth;
      const eyeMidX = (leftEyeInner.x + rightEyeInner.x) / 2;
      const yawOffset = noseTip.x - eyeMidX;

      const headIsTurned = Math.abs(yawOffset) > 0.03;
      const isLooking = irisPos >= 0.2 && irisPos <= 0.8;
      const isFocused = isLooking && !headIsTurned;

      updateFocusStats(isFocused);

      const logData = {
        irisPos: irisPos.toFixed(3),
        yawOffset: yawOffset.toFixed(3)
      };

      if (isFocused) {
        logEvent("gazeLogs", "gaze", "User is FOCUSED on screen", logData);
      } else if (headIsTurned) {
        logEvent("gazeLogs", "gaze", "User head is turned (not facing screen)", logData);
      } else {
        logEvent("gazeLogs", "gaze", "User eyes are not focused on screen", logData);
      }

      printFocusStats();
    }, 1000);

    await import("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
    const Camera = window.Camera;

    if (!useFakeVideo) {
      const camera = new Camera(video, {
        onFrame: async () => {
          await facemesh.send({ image: video });
        },
        width: video_width,
        height: video_height
      });
      camera.start();

      document.addEventListener("visibilitychange", () => {
        if (document.hidden) camera.stop();
        else camera.start();
      });
    } else {
      const processFrame = async () => {
        await facemesh.send({ image: video });
        requestAnimationFrame(processFrame);
      };
      processFrame();
    }

  } catch (e) {
    logEvent("gazeLogs", "cameraAccess", "Camera access denied or error", { error: e.message });
    alert("Camera access is required for gaze tracking.");
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
startGazeTracking(true, 320, 240);
