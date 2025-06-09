let isFullscreen = false;

// Central logs object to collect all exam-related event logs (don't overwrite if already defined)
window.examLogs = window.examLogs || {};

// Helper to add a structured log entry (shared globally)
window.examLogEvent = window.examLogEvent || function(type, message, data = {}) {
  if (!window.examLogs[type]) window.examLogs[type] = [];
  window.examLogs[type].push({
    timestamp: new Date().toISOString(),
    message,
    ...data
  });
};

// --- Fullscreen Toggle ---
// IMPORTANT: To use this function, create a separate button element in your HTML,
// and set its onclick attribute to "toggleFullscreen()".
function toggleFullscreen() {
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch((e) => {
      console.error("Fullscreen request failed:", e);
      window.examLogEvent('fullscreen', 'Fullscreen request failed', { error: e.toString() });
    });
  } else {
    document.exitFullscreen();
  }
}

// --- Fullscreen Monitoring (Single Listener with Warning & Cooldown) ---
(() => {
  let warningCountFullscreenExit = 0;
  const maxWarnings = 3;
  let lastWarningTime = 0;
  const cooldown = 3000; // 3 seconds cooldown to prevent alert spam

  document.addEventListener("fullscreenchange", () => {
    isFullscreen = !!document.fullscreenElement;
    const now = Date.now();

    if (isFullscreen) {
      window.examLogEvent('fullscreen', 'Entered fullscreen mode');
    } else {
      window.examLogEvent('fullscreen', 'Exited fullscreen mode');

      if (now - lastWarningTime > cooldown && warningCountFullscreenExit < maxWarnings) {
        warningCountFullscreenExit++;
        lastWarningTime = now;

        alert(`Warning: You exited fullscreen mode! Warning ${warningCountFullscreenExit}/${maxWarnings}`);
        window.examLogEvent('fullscreenWarnings', `Fullscreen exit warning ${warningCountFullscreenExit}`, { warningCountFullscreenExit });

        if (warningCountFullscreenExit >= maxWarnings) {
          alert("Exam suspended or auto-submitted due to repeated fullscreen exits.");
          window.examLogEvent('fullscreenWarnings', 'Max fullscreen exit warnings reached - exam suspended or auto-submitted');
          // TODO: Add exam suspend or auto-submit logic here
        }
      }
    }
  });
})();

// --- Keyboard Shortcut Blocking & Multi-Tab Detection & full screen, visiblity, blur change ---
(() => {
  const bc = new BroadcastChannel('exam_channel');
  const TAB_KEY = 'exam_tab_open';
  const POPUP_COOLDOWN_MS = 4000;

  let lastPopupTime = 0;
  let isPopupOpen = false;

  // To avoid redundant logs
  let isNonCompliantLogged = false;

  // Check if fullscreen is active (standard)
  const isFullscreen = () => document.fullscreenElement !== null;

  // Mobile-friendly fullscreen check based on viewport vs screen size
  function isFullScreenEnough() {
    const heightRatio = window.innerHeight / screen.height;
    const widthRatio = window.innerWidth / screen.width;
    // Accept if viewport covers at least 90% height and 95% width of the screen
    return heightRatio >= 0.9 && widthRatio >= 0.95;
  }

  // Combined compliance check: fullscreen OR large enough viewport
  const isStrictlyCompliant = () => {
    return isFullscreen() || isFullScreenEnough();
  };

  // Show alert if not compliant, with mobile-friendly message
  const showComplianceAlert = () => {
    const now = Date.now();
    if (!isPopupOpen && now - lastPopupTime >= POPUP_COOLDOWN_MS) {
      isPopupOpen = true;

      // Different message for portrait mobile users
      const mobileMsg = "📱 Please rotate your device to landscape and enter fullscreen or maximize browser to continue.";
      const desktopMsg = "Please maximize your browser window or enter fullscreen to continue the exam.";
      const msg = (window.innerWidth < window.innerHeight) ? mobileMsg : desktopMsg;

      alert(msg);
      lastPopupTime = now;
      isPopupOpen = false;
    }
  };

  const checkCompliance = () => {
    if (!isStrictlyCompliant()) {
      showComplianceAlert();
      if (!isNonCompliantLogged) {
        window.examLogEvent('focus', '⚠️ Window is not fullscreen or not maximized enough');
        isNonCompliantLogged = true;
      }
    } else {
      // Reset log flag if compliance restored
      isNonCompliantLogged = false;
    }
  };

  // Run compliance check four second
  setInterval(checkCompliance, 4000);

  // Log fullscreen changes
  document.addEventListener('fullscreenchange', () => {
    if (!isFullscreen()) {
      window.examLogEvent('fullscreen', 'Exited fullscreen');
    } else {
      window.examLogEvent('fullscreen', 'Entered fullscreen');
    }
  });

  // Check compliance on resize, focus
  window.addEventListener('resize', checkCompliance);
  window.addEventListener('focus', checkCompliance);

  // Log blur event
  window.addEventListener('blur', () => {
    window.examLogEvent('focus', 'Window lost focus');
  });

  // Visibility change events
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      window.examLogEvent('focus', 'Tab hidden (visibilitychange)');
    } else {
      checkCompliance();
    }
  });

  // Detect multi-tab exam openings using BroadcastChannel
  bc.onmessage = (event) => {
    if (event.data === 'exam_opened') {
      alert("Multiple exam tabs detected! This is not allowed.");
      window.examLogEvent('multitab', 'Detected multiple exam tabs via BroadcastChannel');
    }
  };

  window.addEventListener('load', () => {
    bc.postMessage('exam_opened');
    localStorage.setItem(TAB_KEY, 'open');
    window.examLogEvent('multitab', 'Broadcasted exam tab opened');
    window.examLogEvent('multitab', 'Set localStorage tab open flag');
    checkCompliance();
  });

  // Detect multi-tab openings using localStorage changes
  window.addEventListener('storage', (e) => {
    if (e.key === TAB_KEY && e.newValue === 'open') {
      alert("Multiple exam tabs detected via localStorage! This is not allowed.");
      window.examLogEvent('multitab', 'Detected multiple exam tabs via localStorage');
    }
  });

  // Cleanup localStorage flag on unload
  window.addEventListener('beforeunload', () => {
    localStorage.removeItem(TAB_KEY);
    window.examLogEvent('multitab', 'Removed localStorage tab open flag');
  });
})();

// --- Exam Security Features ---
function exam_initiated_security() {
  let devtoolsOpen = false;
  const threshold = 160;
  let devtoolsInterval, devtoolsDebuggerInterval, screenFocusInterval;

  // Detect DevTools via window size
  function detectDevTools() {
    const widthThreshold = window.outerWidth - window.innerWidth > threshold;
    const heightThreshold = window.outerHeight - window.innerHeight > threshold;
    if ((widthThreshold || heightThreshold) && !devtoolsOpen) {
      devtoolsOpen = true;
      alert("DevTools detected! Exam will be locked.");
      window.examLogEvent('devtools', 'DevTools detected by size threshold');
      // TODO: Lock or suspend exam logic here
    }
  }

  // Detect DevTools via debugger trap
  function detectDevToolsDebuggerTrap() {
    const devtoolsChecker = new Function('debugger');
    const start = performance.now();
    devtoolsChecker();
    const duration = performance.now() - start;

    if (duration > 100 && !devtoolsOpen) {
      devtoolsOpen = true;
      alert("DevTools detected via debugger trap!");
      window.examLogEvent('devtools', 'DevTools detected via debugger trap');
      // TODO: Lock or suspend exam logic here
    }
  }

  // Block right-click and clipboard
  function blockRightClickCopyPaste() {
    document.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      window.examLogEvent('keyboard', 'Blocked right-click context menu');
    });
    ["copy", "paste", "cut"].forEach((event) => {
      document.addEventListener(event, (e) => {
        e.preventDefault();
        window.examLogEvent('keyboard', `Blocked ${event} event`);
      });
    });
  }

  // Block general shortcut keys
  function blockGeneralShortcuts() {
    document.addEventListener("keydown", (e) => {
      const key = e.key.toLowerCase();
      if (
        e.ctrlKey && ['c', 'v', 'x', 'u', 's'].includes(key)
      ) {
        e.preventDefault();
        window.examLogEvent('keyboard', `Blocked key combo: Ctrl+${key}`, { ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, key: e.key });
      }
    });
  }

  // Block DevTools shortcut keys
  function blockDevToolsShortcuts() {
    document.addEventListener("keydown", (e) => {
      const key = e.key.toLowerCase();
      if (
        (e.ctrlKey && e.shiftKey && ['i', 'j'].includes(key)) ||
        e.key === "F12"
      ) {
        e.preventDefault();
        window.examLogEvent('devtools', `Blocked devtools key combo: ${e.ctrlKey ? 'Ctrl+' : ''}${e.shiftKey ? 'Shift+' : ''}${key}`, {
          ctrlKey: e.ctrlKey,
          shiftKey: e.shiftKey,
          key: e.key
        });
      }
    });
  }

  // Detect focus loss
  function checkScreenFocus() {
    if (!document.hasFocus()) {
      alert("Warning: Exam tab not in focus!");
      window.examLogEvent('focus', 'Exam tab lost focus');
      // TODO: Warning or suspend exam logic here
    }
  }

  // Immediate checks and start intervals

  detectDevTools();
  detectDevToolsDebuggerTrap();
  blockDevToolsShortcuts();

  devtoolsInterval = setInterval(detectDevTools, 1000);
  devtoolsDebuggerInterval = setInterval(detectDevToolsDebuggerTrap, 2000);

  blockRightClickCopyPaste();
  blockGeneralShortcuts();
  checkScreenFocus();
  screenFocusInterval = setInterval(checkScreenFocus, 5000);
}

exam_initiated_security();

// --- Time Spent Per Question Logging ---
// Usage: Add `onclick="logTimeBetweenClicks()"` on each question option element.
// The function alerts the time difference between last click and current click to help track user response time.
let lastClickTime = null;
let questionCounter = 1;
const questionMap = new Map();

function attachClickLoggersToRadios() {
  const radios = document.querySelectorAll('input.form-check-input[type="radio"]');

  radios.forEach(radio => {
    // Use name attribute to group radios for a single question (e.g., option_14637)
    const name = radio.getAttribute('name');

    if (!questionMap.has(name)) {
      questionMap.set(name, `Question ${questionCounter++}`);
    }

    const questionId = questionMap.get(name);
    radio.onclick = () => logTimeBetweenClicks(questionId);
  });
}

(() => {
  window.logTimeBetweenClicks = function(questionId) {
    const now = Date.now();

    if (lastClickTime !== null) {
      const diffMs = now - lastClickTime;
      window.examLogEvent('questionTiming', `Time between clicks for ${questionId}`, { diffMs });
    } else {
      window.examLogEvent('questionTiming', `First click on ${questionId}`);
    }

    lastClickTime = now;
  };

  document.addEventListener('DOMContentLoaded', attachClickLoggersToRadios);
})();






// --- Optional periodic console output for logs ---
// (Uncomment to enable)
// (function autoLogConsoleOutput() {
//   setInterval(() => {
//     console.log("===== Exam Security Logs Snapshot =====");
//     console.log(JSON.stringify(window.examLogs, null, 2));
//     console.log("=======================================");
//   }, 30000); // every 30 seconds
// })();
