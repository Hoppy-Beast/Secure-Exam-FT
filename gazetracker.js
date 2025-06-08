// Global gaze logs
window.gazeLogs = window.gazeLogs || {};

// Gaze logging function
window.gazeLogEvent = window.gazeLogEvent || function (type, message, data = {}) {
  if (!window.gazeLogs[type]) window.gazeLogs[type] = [];
  const entry = {
    timestamp: new Date().toISOString(),
    message,
    ...data
  };
  window.gazeLogs[type].push(entry);
  console.log(`[${type}] ${message}`, data);
};

// Track focus stats
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

function printFocusStats() {
  if (focusStats.total === 0) return;
  const focusedPercent = ((focusStats.focused / focusStats.total) * 100).toFixed(1);
  const notFocusedPercent = ((focusStats.notFocused / focusStats.total) * 100).toFixed(1);
  console.log(`📊 Focus Stats: Focused: ${focusedPercent}%, Not Focused: ${notFocusedPercent}%`);
}

// Load MediaPipe FaceMesh
async function loadFaceMesh() {
  await import("https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh");
  const FaceMesh = window.FaceMesh; // Use from global context

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
      video.src = "gaze-tracking-sample.mp4"; // Replace with a real file
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      await video.play();
      document.body.appendChild(video);

      window.gazeLogEvent("cameraAccess", "Fake video loaded for gaze tracking");
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 320, min: 160, max: 480 },     // flexible between 160 and 480, ideally 320
          height: { ideal: 240, min: 120, max: 360 },    // flexible height range
          frameRate: { ideal: 15, min: 10, max: 24 },    // low-medium fps to balance smoothness & perf
          facingMode: "user"                             // front camera if on mobile devices
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

      window.gazeLogEvent("cameraAccess", "Camera access granted");
    }

    const facemesh = await loadFaceMesh();

    let lastLogTime = 0;
    const logThrottleMs = 1000;

    facemesh.onResults(({ multiFaceLandmarks }) => {
      if (!multiFaceLandmarks?.length) return;

      const lm = multiFaceLandmarks[0];
      const leftEyeOuter = lm[33];
      const leftEyeInner = lm[133];
      const leftIris = lm[468];

      const eyeWidth = leftEyeInner.x - leftEyeOuter.x;
      if (eyeWidth <= 0) return;

      const irisPos = (leftIris.x - leftEyeOuter.x) / eyeWidth;

      // Define "focused" if irisPos is roughly between 0.2 and 0.8 (looking roughly center)
      const isFocused = irisPos >= 0.2 && irisPos <= 0.8;

      const now = Date.now();
      if (now - lastLogTime > logThrottleMs) {
        updateFocusStats(isFocused);
        if (isFocused) {
          window.gazeLogEvent("gaze", "User is FOCUSED on screen", { irisPos: irisPos.toFixed(3) });
        } else {
          window.gazeLogEvent("gaze", "User is NOT focused on screen", { irisPos: irisPos.toFixed(3) });
        }

        // Print stats every 5 logs (5 seconds)
        if (focusStats.total % 5 === 0) {
          printFocusStats();
        }

        lastLogTime = now;
      }
    });

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
    window.gazeLogEvent("cameraAccess", "Camera access denied or error", { error: e.message });
    alert("Camera access is required for gaze tracking.");
  }
}

// logs management in localstorage and variable
// Default base structures
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

// Merge two logs based on expected structure
function mergeLogs(current = {}, stored = {}, type) {
  const merged = {};
  const defaultStructure = DEFAULT_LOG_STRUCTURES[type];

  Object.keys(defaultStructure).forEach(key => {
    const cur = current[key] || [];
    const sto = stored[key] || [];
    merged[key] = [...sto, ...cur]; // old first, new later
  });

  return merged;
}

function syncLogs(logKey, globalVarName) {
  const storedLogs = JSON.parse(localStorage.getItem(logKey)) || null;
  const currentLogs = window[globalVarName] || {};

  let finalLogs;
  const hasStored = storedLogs && Object.keys(storedLogs).length > 0;
  const hasCurrent = currentLogs && Object.keys(currentLogs).length > 0;

  if (!hasStored && !hasCurrent) {
    finalLogs = { ...DEFAULT_LOG_STRUCTURES[globalVarName] };
  } else if (!hasStored) {
    finalLogs = mergeLogs(currentLogs, {}, globalVarName);
  } else if (!hasCurrent) {
    finalLogs = mergeLogs({}, storedLogs, globalVarName);
  } else {
    finalLogs = mergeLogs(currentLogs, storedLogs, globalVarName);
  }

  window[globalVarName] = finalLogs;
  localStorage.setItem(logKey, JSON.stringify(finalLogs));
}

// Run every 30 seconds
setInterval(() => {
  syncLogs("examLogs", "examLogs");
  syncLogs("gazeLogs", "gazeLogs");
}, 30000);




// Start gaze tracking (true = use sample video; false = use webcam)
startGazeTracking(false, 320, 240);

// send this to back end for analysis the data
// or analize here in client side ( not recommended )
function all_logs() {
  window.unifiedExamReport = {
    examEvents: window.examLogs || {},
    gazeEvents: window.gazeLogs || {}
  };
  return window.unifiedExamReport;
}


// test purpose
setTimeout(() => {
  const dataStr = "data:text/json;charset=utf-8," + encodeURIComponent(JSON.stringify(all_logs(), null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute("href", dataStr);
  downloadAnchor.setAttribute("download", "unified_exam_report.json");
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  document.body.removeChild(downloadAnchor);
  console.log("✅ Download triggered for unifiedExamReport.");
}, 25000); // 25 seconds
