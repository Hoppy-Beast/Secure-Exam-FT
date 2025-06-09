const statusEl = document.getElementById("status");
const useFakeVideoCheckbox = document.getElementById("useFakeVideo");
const startBtn = document.getElementById("start-btn");
const trackingVideoEl = document.getElementById("tracking-video");

const focusStats = {
  focused: 0,
  notFocused: 0,
  total: 0
};

function logEvent(source, type, message, data = {}) {
  console.log(`[${source}] ${type}: ${message}`, data);
}

function updateFocusStats(isFocused) {
  if (isFocused) focusStats.focused++;
  else focusStats.notFocused++;
  focusStats.total++;
  statusEl.textContent = isFocused ? "✅ Focused on screen" : "❌ Not focused";
}

let lastFocusLogTime = 0;
function printFocusStats() {
  const now = Date.now();
  if (focusStats.total === 0) return;
  const interval = 10 * 1000;
  if (now - lastFocusLogTime < interval) return;

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

async function startGazeTracking(useFakeVideo = false) {
  try {
    let video = trackingVideoEl;

    if (useFakeVideo) {
      video.src = "/gaze-tracking-sample.mp4"; // Ensure the file exists
      video.loop = true;
      await video.play();
      logEvent("gazeLogs", "cameraAccess", "Fake video loaded");
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 320 },
          height: { ideal: 240 },
          facingMode: "user"
        },
        audio: false
      });

      video.srcObject = stream;
      await video.play();
      logEvent("gazeLogs", "cameraAccess", "Camera access granted");
    }

    const facemesh = await loadFaceMesh();
    let latestLandmarks = null;

    facemesh.onResults(({ multiFaceLandmarks }) => {
      latestLandmarks = multiFaceLandmarks?.[0] || null;
    });

    setInterval(() => {
      if (!latestLandmarks) {
        updateFocusStats(false);
        logEvent("gazeLogs", "gaze", "No face detected");
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
        logEvent("gazeLogs", "gaze", "Invalid eye width");
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
        logEvent("gazeLogs", "gaze", "User is FOCUSED", logData);
      } else if (headIsTurned) {
        logEvent("gazeLogs", "gaze", "Head turned", logData);
      } else {
        logEvent("gazeLogs", "gaze", "Eyes not focused", logData);
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
        width: 320,
        height: 240
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
    logEvent("gazeLogs", "cameraAccess", "Error", { error: e.message });
    alert("Camera access is required for gaze tracking.");
    statusEl.textContent = "❌ Failed to initialize";
  }
}

startBtn.addEventListener("click", () => {
  const useFake = useFakeVideoCheckbox.checked;
  startBtn.disabled = true;
  startGazeTracking(useFake);
});
