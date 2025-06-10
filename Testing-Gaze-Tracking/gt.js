// --- Meta Data & Constants ---
const statusEl = document.getElementById("status");
const useFakeVideoCheckbox = document.getElementById("useFakeVideo");
const startBtn = document.getElementById("start-btn");
const videoEl = document.getElementById("tracking-video");

const FRAME_WIDTH = 480;
const FRAME_HEIGHT = 360;

const BUFFER_SIZE = 15; // smooth last 15 results
let directionBuffer = [];

const DIRECTION_ICONS = {
  center: "✅ Looking Center",
  up: "👆 Looking Up",
  down: "👇 Looking Down",
  left: "👈 Looking Left",
  right: "👉 Looking Right",
  unknown: "❓ Unknown",
};

// Eye landmarks indexes (MediaPipe FaceMesh)
const LEFT_EYE_LANDMARKS = [33, 133, 159, 145];   // left corner, right corner, upper eyelid, lower eyelid
const RIGHT_EYE_LANDMARKS = [362, 263, 386, 374]; // left corner, right corner, upper eyelid, lower eyelid

const THRESHOLD_IRIS_POS = 0.15; // threshold for iris position inside eye box (tweak as needed)
const HEAD_TURN_THRESHOLD = 0.05; // head yaw threshold

// --- Utility Functions ---
function updateStatus(direction) {
  statusEl.textContent = DIRECTION_ICONS[direction] || DIRECTION_ICONS.unknown;
}

function smoothDirection() {
  if (directionBuffer.length < BUFFER_SIZE) return "unknown";
  const counts = {};
  directionBuffer.forEach(dir => counts[dir] = (counts[dir] || 0) + 1);
  let maxDir = "unknown";
  let maxCount = 0;
  for (const [dir, count] of Object.entries(counts)) {
    if (count > maxCount) {
      maxCount = count;
      maxDir = dir;
    }
  }
  return maxDir;
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

function getEyeBox(landmarks, indices) {
  // Calculate bounding box of the eye using corner and eyelid landmarks
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
  // Normalize iris position within eye box (0 to 1)
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

// --- Main function ---
async function startGazeTracking(useFakeVideo = false) {
  try {
    videoEl.width = FRAME_WIDTH;
    videoEl.height = FRAME_HEIGHT;

    if (useFakeVideo) {
      videoEl.src = "/gaze-tracking-sample.mp4";
      await videoEl.play();
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { width: FRAME_WIDTH, height: FRAME_HEIGHT, facingMode: "user" },
        audio: false
      });
      videoEl.srcObject = stream;
      await videoEl.play();
    }

    const facemesh = await loadFaceMesh();

    let latestLandmarks = null;
    facemesh.onResults(({ multiFaceLandmarks }) => {
      latestLandmarks = multiFaceLandmarks?.[0] || null;
    });

    // Canvas overlay for debug points
    const canvas = document.createElement("canvas");
    canvas.width = FRAME_WIDTH;
    canvas.height = FRAME_HEIGHT;
    canvas.style.position = "absolute";
    canvas.style.top = videoEl.offsetTop + "px";
    canvas.style.left = videoEl.offsetLeft + "px";
    canvas.style.zIndex = 1000;
    document.body.appendChild(canvas);
    const ctx = canvas.getContext("2d");

    async function processFrame() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(videoEl, 0, 0, canvas.width, canvas.height);

      if (!latestLandmarks) {
        directionBuffer.push("unknown");
        if (directionBuffer.length > BUFFER_SIZE) directionBuffer.shift();
        updateStatus("unknown");
        requestAnimationFrame(processFrame);
        return;
      }

      const lm = latestLandmarks;

      // Calculate eye boxes
      const leftEyeBox = getEyeBox(lm, LEFT_EYE_LANDMARKS);
      const rightEyeBox = getEyeBox(lm, RIGHT_EYE_LANDMARKS);

      // Get normalized iris positions relative to each eye box
      const leftIrisPos = getNormalizedIrisPos(lm[468], leftEyeBox);
      const rightIrisPos = getNormalizedIrisPos(lm[473], rightEyeBox);

      // Calculate eye center as midpoint between eyes (for head turn check)
      const leftEyeCenter = { x: (lm[33].x + lm[133].x) / 2, y: (lm[33].y + lm[133].y) / 2 };
      const rightEyeCenter = { x: (lm[362].x + lm[263].x) / 2, y: (lm[362].y + lm[263].y) / 2 };
      const eyeCenter = { x: (leftEyeCenter.x + rightEyeCenter.x) / 2, y: (leftEyeCenter.y + rightEyeCenter.y) / 2 };

      const noseTip = lm[1];

      // Draw debug points
      [lm[33], lm[133], lm[159], lm[145], lm[362], lm[263], lm[386], lm[374], lm[468], lm[473], noseTip].forEach(pt => {
        ctx.beginPath();
        ctx.arc(pt.x * canvas.width, pt.y * canvas.height, 4, 0, 2 * Math.PI);
        ctx.fillStyle = "cyan";
        ctx.fill();
      });

      // Check if head is turned
      const turned = isHeadTurned(noseTip, eyeCenter);

      let gazeDirection = "unknown";
      if (!turned) {
        gazeDirection = detectGazeDirectionByIrisPos(leftIrisPos, rightIrisPos);
      }

      // Add to buffer and smooth direction
      directionBuffer.push(gazeDirection);
      if (directionBuffer.length > BUFFER_SIZE) directionBuffer.shift();

      const smoothDir = smoothDirection();
      updateStatus(smoothDir);

      requestAnimationFrame(processFrame);
    }

    if (!useFakeVideo) {
      const camera = new window.Camera(video, {
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
      async function fakeLoop() {
        await facemesh.send({ image: videoEl });
        requestAnimationFrame(fakeLoop);
      }
      fakeLoop();
    }

    processFrame();

  } catch (e) {
    console.error("Gaze tracking error:", e);
    statusEl.textContent = "❌ Error: " + e.message;
  }
}

// --- Event Listeners ---
startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  startGazeTracking(useFakeVideoCheckbox.checked);
});
