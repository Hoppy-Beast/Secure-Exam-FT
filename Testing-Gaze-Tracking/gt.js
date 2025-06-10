const statusEl = document.getElementById("status");
const useFakeVideoCheckbox = document.getElementById("useFakeVideo");
const startBtn = document.getElementById("start-btn");
const videoEl = document.getElementById("tracking-video");

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

// Iris landmark indices — try swapping if needed
const LEFT_IRIS = 468;
const RIGHT_IRIS = 473;

const THRESHOLD_IRIS_POS    = 0.23;  // forgiving margin around center (tweak if needed)
const HEAD_TURN_THRESHOLD  = 0.08; // tolerate a bit of yaw

function logEvent(...args) {
  console.log(...args);
}

function updateStatus(direction) {
  statusEl.textContent = DIRECTION_ICONS[direction] || DIRECTION_ICONS.unknown;
}

function smoothDirection() {
  if (directionBuffer.length < BUFFER_SIZE) return "unknown";
  const counts = {};
  directionBuffer.forEach(dir => counts[dir] = (counts[dir]||0) + 1);
  return Object.entries(counts).reduce((a, b) => a[1]>b[1]?a:b)[0];
}

async function loadFaceMesh() {
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
  return facemesh;
}

// Improved eye box function with min/max approach
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

function clamp(v, min=0, max=1) {
  return Math.min(max, Math.max(min, v));
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

async function startGazeTracking(useFakeVideo = false) {
  try {
    let video = videoEl;
    if (useFakeVideo) {
      video.src = "/Secure-Exam-FT/gaze-tracking-sample.mp4";
      video.autoplay = video.loop = video.muted = video.playsInline = true;
      video.style.display = "block";
      await video.play().catch(() => alert("Failed to play fake video."));
      logEvent("gazeLogs","cameraAccess","Fake video loaded");
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({
        video:{
          width:{ideal:FRAME_WIDTH,min:160,max:480},
          height:{ideal:FRAME_HEIGHT,min:120,max:360},
          frameRate:{ideal:15,min:10,max:24},
          facingMode:"user"
        }, audio:false
      });
      video.srcObject = stream;
      video.autoplay = video.muted = video.playsInline = true;
      video.style.display = "block";
      await video.play();
      logEvent("gazeLogs","cameraAccess","Camera access granted");
    }

    const facemesh = await loadFaceMesh();
    let latestLandmarks = null;
    facemesh.onResults(({multiFaceLandmarks}) => {
      latestLandmarks = multiFaceLandmarks?.[0] || null;
    });

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

        // Debug logs - comment out if too noisy
        // console.log("Iris avg pos:", ((leftIris.x + rightIris.x)/2).toFixed(2), ((leftIris.y + rightIris.y)/2).toFixed(2));

        const eyeCenter = {
          x: (lm[33].x + lm[133].x + lm[362].x + lm[263].x)/4,
          y: (lm[33].y + lm[133].y + lm[362].y + lm[263].y)/4
        };

        if (!isHeadTurned(lm[1], eyeCenter)) {
          dir = detectGazeDirectionByIrisPos(leftIris, rightIris);
        }
      }

      directionBuffer.push(dir);
      if (directionBuffer.length > BUFFER_SIZE) directionBuffer.shift();

      const smoothDir = smoothDirection();
      updateStatus(smoothDir);

      if (
        now - lastLogTime >= LOG_INTERVAL &&
        smoothDir !== "unknown" &&
        (!directionCooldown[smoothDir] || now - directionCooldown[smoothDir] > COOLDOWN_MS)
      ) {
        const msg = smoothDir === "center"
          ? "User is looking at the screen"
          : "User eyes are not focused on screen";
        logEvent("gazeLogs","gaze",msg,{direction:smoothDir});
        directionCooldown[smoothDir] = now;
        lastLogTime = now;
      }

      requestAnimationFrame(processFrame);
    }

    const camMod = await import("https://cdn.jsdelivr.net/npm/@mediapipe/camera_utils/camera_utils.js");
    const Camera  = camMod.Camera || window.Camera;
    if (!useFakeVideo) {
      const camera = new Camera(video, {
        onFrame: async()=>{ await facemesh.send({image:video}); },
        width:FRAME_WIDTH,height:FRAME_HEIGHT
      });
      camera.start();
      document.addEventListener("visibilitychange",()=>{
        document.hidden ? camera.stop() : camera.start();
      });
    } else {
      (async function loop(){
        await facemesh.send({image:video});
        requestAnimationFrame(loop);
      })();
    }

    processFrame();
  } catch (e) {
    logEvent("gazeLogs","cameraAccess","Camera error",{error:e.message});
    alert("Camera error: " + e.message);
  }
}

startBtn.addEventListener("click", () => {
  startBtn.disabled = true;
  startGazeTracking(useFakeVideoCheckbox.checked);
});
