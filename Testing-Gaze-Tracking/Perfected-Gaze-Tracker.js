

const statusEl = document.getElementById("status");
const useFakeVideoCheckbox = document.getElementById("useFakeVideo");
const startBtn = document.getElementById("start-btn");
const videoEl = document.getElementById("tracking-video");

const FRAME_WIDTH = 480;
const FRAME_HEIGHT = 360;
const BUFFER_SIZE = 15;
const directionBuffer = [];

const DIRECTION_ICONS = {
  center: "✅ Looking Center",
  up: "👆 Looking Up",
  down: "👇 Looking Down",
  left: "👈 Looking Left",
  right: "👉 Looking Right",
  unknown: "❓ Unknown",
};

const LEFT_EYE_LANDMARKS = [33, 133, 159, 145];
const RIGHT_EYE_LANDMARKS = [362, 263, 386, 374];
const THRESHOLD_IRIS_POS = 0.15;
const HEAD_TURN_THRESHOLD = 0.05;

function updateStatus(direction) {
  statusEl.textContent = DIRECTION_ICONS[direction] || DIRECTION_ICONS.unknown;
}

function smoothDirection() {
  if (directionBuffer.length < BUFFER_SIZE) return "unknown";
  const counts = {};
  directionBuffer.forEach(dir => counts[dir] = (counts[dir] || 0) + 1);
  return Object.entries(counts).reduce((a, b) => a[1] > b[1] ? a : b)[0];
}

async function loadFaceMesh() {
  await import("https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh");
  const FaceMesh = window.FaceMesh;
  const facemesh = new FaceMesh({
    locateFile: (file) => https://cdn.jsdelivr.net/npm/@mediapipe/face_mesh/${file}
  });
  facemesh.setOptions({
    maxNumFaces: 1,
    refineLandmarks: true,
    minDetectionConfidence: 0.7,
    minTrackingConfidence: 0.7
  });
  return facemesh;
}

function getEyeBox(landmarks, indices) {
  const leftCorner = landmarks[indices[0]];
  const rightCorner = landmarks[indices[1]];
  const upperEyelid = landmarks[indices[2]];
  const lowerEyelid = landmarks[indices[3]];

  return {
    left: leftCorner.x,
    right: rightCorner.x,
    top: upperEyelid.y,
    bottom: lowerEyelid.y,
    width: rightCorner.x - leftCorner.x,
    height: lowerEyelid.y - upperEyelid.y,
  };
}

function getNormalizedIrisPos(iris, eyeBox) {
  return {
    x: (iris.x - eyeBox.left) / eyeBox.width,
    y: (iris.y - eyeBox.top) / eyeBox.height,
  };
}

function isHeadTurned(noseTip, eyeCenter) {
  return Math.abs(noseTip.x - eyeCenter.x) > HEAD_TURN_THRESHOLD;
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

async function startGazeTracking(useFakeVideo = false) {
  try {
    const video_width = 320;
    const video_height = 240;
    let video = videoEl;

    if (useFakeVideo) {
      video.src = "/Secure-Exam-FT/gaze-tracking-sample.mp4";
      video.autoplay = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.style.display = "block"; // visible
      await video.play();
      logEvent("gazeLogs", "cameraAccess", "Fake video loaded");
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: video_width, min: 160, max: 480 },
          height: { ideal: video_height, min: 120, max: 360 },
          frameRate: { ideal: 15, min: 10, max: 24 },
          facingMode: "user"
        },
        audio: false
      });

      video.srcObject = stream;
      video.autoplay = true;
      video.muted = true;
      video.playsInline = true;
      video.style.display = "block"; // visible
      await video.play();
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
        const leftIrisPos = getNormalizedIrisPos(lm[472], leftEyeBox);
        const rightIrisPos = getNormalizedIrisPos(lm[468], rightEyeBox);

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
      updateStatus(smoothDir);

      if (
        now - lastLogTime >= LOG_INTERVAL &&
        smoothDir !== "unknown" &&
        (!directionCooldown[smoothDir] || now - directionCooldown[smoothDir] > COOLDOWN_MS)
      ) {
        const message = smoothDir === "center"
          ? "User is looking at the screen"
          : "User eyes are not focused on screen";

        const logData = {
          direction: smoothDir
        };

        logEvent("gazeLogs", "gaze", message, logData);
        directionCooldown[smoothDir] = now;
        lastLogTime = now;
      }

      requestAnimationFrame(processFrame);
    }

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
      async function loop() {
        await facemesh.send({ image: video });
        requestAnimationFrame(loop);
      }
      loop();
    }

    processFrame();
  } catch (e) {
    logEvent("gazeLogs", "cameraAccess", "Camera error", { error: e.message });
    alert("Camera access is denied (suspicious)");
  }
}

startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  startGazeTracking(useFakeVideoCheckbox.checked);
});
