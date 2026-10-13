const AUDIO_BASE = "https://raadio.run.place/radio.mp3";
const API_BASE = "https://raadio.run.place/skip";
const META_URL   = "https://raadio.run.place/now-playing";

const audioPlayer = new Audio();
const dashboardText = document.getElementById('dashboard-text');
const playerEl = document.getElementById("player");
const playPauseBtn = document.getElementById("play-pause-btn");
const playIcon = document.getElementById("play-icon");
const pauseIcon = document.getElementById("pause-icon");
const songNameEl = document.getElementById("song-name");
const artistNameEl = document.getElementById("artist-name");
const waveCanvas = document.getElementById("wave-bar");
const waveCtx = waveCanvas.getContext("2d");
const titleElement  = document.getElementById('song-title');
const singerElement = document.getElementById('singer-name');

// Auto dark mode based on hour
function applyDarkMode() {
  const hour = new Date().getHours();
  if (hour >= 18 || hour < 6) {
    document.body.classList.add('dark-mode');
  } else {
    document.body.classList.remove('dark-mode');
  }
  updateThemeColor();
}

// Update theme-color meta tag based on dark mode
function updateThemeColor() {
  const metaThemeColor = document.getElementById('theme-color');
  if (document.body.classList.contains('dark-mode')) {
    metaThemeColor.setAttribute('content', '#1a1815');
  } else {
    metaThemeColor.setAttribute('content', '#f4f1ea');
  }
}

applyDarkMode();

// Update dark mode every minute
setInterval(applyDarkMode, 60000);

let userPaused = true;
let retryTimer = null;
let streamStartedAt = 0;
let frozenProgress = 0;
let waveTime = 0;
let isPlaying = false;

function updateDashboard(text) {
  dashboardText.innerText = text;
}

function startStream() {
  clearTimeout(retryTimer);
  audioPlayer.src = AUDIO_BASE + "?t=" + Date.now();
  audioPlayer.play()
    .then(() => {
      updateDashboard("Playing live stream...");
      isPlaying = true;
      playerEl.classList.add("is-live");
      playIcon.style.display = "none";
      pauseIcon.style.display = "block";
      streamStartedAt = performance.now();
    })
    .catch(() => {
      updateDashboard("Click PLAY again.");
      isPlaying = false;
      playerEl.classList.remove("is-live");
      playIcon.style.display = "block";
      pauseIcon.style.display = "none";
    });
}

function reconnect() {
  if (userPaused) return;
  updateDashboard("Next track...");
  clearTimeout(retryTimer);
  retryTimer = setTimeout(startStream, 1500);
}
// Function to update the player display dynamically
function updateTrackDisplay(songName, artistName) {
  document.getElementById('song-name').textContent = songName;
  document.getElementById('artist-name').textContent = artistName;
}

// Example usage when switching tracks:
// updateTrackDisplay("Golden Hour Echoes", "Retro Horizon");


playPauseBtn.addEventListener('click', () => {
  if (isPlaying) {
    userPaused = true;
    clearTimeout(retryTimer);
    audioPlayer.pause();
    updateDashboard("Paused.");
    isPlaying = false;
    playerEl.classList.remove("is-live");
    playIcon.style.display = "block";
    pauseIcon.style.display = "none";
    frozenProgress = getProgress();
  } else {
    userPaused = false;
    updateDashboard("Connecting...");
    startStream();
  }
});

document.getElementById('skip-btn').addEventListener('click', async () => {
  updateDashboard("Voting to skip...");
  try {
    const res = await fetch(API_BASE, { method: 'POST' });
    const data = await res.json();
    updateDashboard(data.message);
    if (data.status === "success" || data.message.includes("globally")) reconnect();
  } catch (err) {
    updateDashboard("Error hitting skip server.");
    console.error(err);
  }
});

audioPlayer.addEventListener('ended', reconnect);
audioPlayer.addEventListener('error', reconnect);
audioPlayer.addEventListener('stalled', reconnect);



// Wave bar visualization
function getProgress() {
  const duration = audioPlayer.duration;
  if (Number.isFinite(duration) && duration > 0) {
    return Math.min(1, Math.max(0, audioPlayer.currentTime / duration));
  }
  if (userPaused || audioPlayer.paused) return frozenProgress;
  const elapsed = (performance.now() - streamStartedAt) / 1000;
  return (elapsed % 180) / 180;
}

function sizeWave() {
  const rect = waveCanvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  waveCanvas.width = Math.max(1, Math.floor(rect.width * dpr));
  waveCanvas.height = Math.max(1, Math.floor(rect.height * dpr));
}

function drawWave(ts) {
  waveTime = ts * 0.001;
  const progress = getProgress();
  if (!userPaused && !audioPlayer.paused) frozenProgress = progress;

  const w = waveCanvas.width;
  const h = waveCanvas.height;
  const bars = 42;
  const gap = w * 0.008;
  const barW = (w - gap * (bars - 1)) / bars;
  const fillX = progress * w;

  waveCtx.clearRect(0, 0, w, h);

  for (let i = 0; i < bars; i += 1) {
    const x = i * (barW + gap);
    const n =
      Math.sin(i * 0.37 + waveTime * 2.1) * 0.28 +
      Math.sin(i * 0.13 + waveTime * 1.15) * 0.22 +
      0.42;
    const barH = Math.max(h * 0.18, n * h * 0.9);
    const y = (h - barH) / 2;
    const filled = x + barW * 0.5 <= fillX;

    waveCtx.fillStyle = filled ? "#c4a35a" : "rgba(92, 87, 78, 0.22)";
    waveCtx.beginPath();
    const r = barW / 2;
    waveCtx.moveTo(x + r, y);
    waveCtx.arcTo(x + barW, y, x + barW, y + barH, r);
    waveCtx.arcTo(x + barW, y + barH, x, y + barH, r);
    waveCtx.arcTo(x, y + barH, x, y, r);
    waveCtx.arcTo(x, y, x + barW, y, r);
    waveCtx.closePath();
    waveCtx.fill();
  }

  requestAnimationFrame(drawWave);
}

// Three.js ambient effect
function initAmbient() {
  const canvas = document.getElementById("ambient");
  if (!window.THREE) return;

  const renderer = new THREE.WebGLRenderer({
    canvas,
    alpha: true,
    antialias: false,
    powerPreference: "low-power"
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.4));
  renderer.setClearColor(0x000000, 0);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 100);
  camera.position.set(0, 0, 12);
  camera.lookAt(0, 0, 0);

  // Floating particles with more depth
  const count = 120;
  const positions = new Float32Array(count * 3);
  const sizes = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    positions[i * 3] = (Math.random() - 0.5) * 24;
    positions[i * 3 + 1] = (Math.random() - 0.5) * 24;
    positions[i * 3 + 2] = (Math.random() - 0.5) * 16 - 4;
    sizes[i] = Math.random() * 0.08 + 0.02;
  }
  const pointsGeo = new THREE.BufferGeometry();
  pointsGeo.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  pointsGeo.setAttribute("size", new THREE.BufferAttribute(sizes, 1));
  const points = new THREE.Points(
    pointsGeo,
    new THREE.PointsMaterial({
      color: 0xc4a35a,
      size: 0.06,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      sizeAttenuation: true
    })
  );
  scene.add(points);

  // Wireframe mesh grid at the back
  const grid = new THREE.Mesh(
    new THREE.PlaneGeometry(32, 32, 24, 24),
    new THREE.MeshBasicMaterial({
      color: 0xc4a35a,
      wireframe: true,
      transparent: true,
      opacity: 0.12
    })
  );
  grid.rotation.x = -Math.PI / 2.2;
  grid.position.y = -4;
  grid.position.z = -6;
  scene.add(grid);

  // Floating geometric shapes
  const shapes = [];
  for (let i = 0; i < 8; i++) {
    const geo = new THREE.IcosahedronGeometry(Math.random() * 0.5 + 0.3, 0);
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({
        color: 0xc4a35a,
        wireframe: true,
        transparent: true,
        opacity: 0.15
      })
    );
    mesh.position.set(
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 18,
      (Math.random() - 0.5) * 8 - 2
    );
    mesh.rotation.set(
      Math.random() * Math.PI,
      Math.random() * Math.PI,
      Math.random() * Math.PI
    );
    shapes.push({
      mesh,
      rotSpeed: (Math.random() - 0.5) * 0.02,
      floatSpeed: Math.random() * 0.5 + 0.5,
      floatOffset: Math.random() * Math.PI * 2
    });
    scene.add(mesh);
  }

  let running = true;
  document.addEventListener("visibilitychange", () => {
    running = document.visibilityState === "visible";
  });

  function resize() {
    const { innerWidth: width, innerHeight: height } = window;
    renderer.setSize(width, height, false);
    camera.aspect = width / Math.max(height, 1);
    camera.updateProjectionMatrix();
  }

  function tick(ts) {
    requestAnimationFrame(tick);
    if (!running) return;
    const t = ts * 0.0001;

    // Rotate and float particles
    points.rotation.y = t * 0.3;
    points.rotation.x = Math.sin(t * 0.5) * 0.1;

    // Animate grid
    grid.rotation.z = Math.sin(t * 0.8) * 0.05;
    grid.position.y = -4 + Math.sin(t * 1.2) * 0.5;

    // Animate floating shapes
    shapes.forEach(shape => {
      shape.mesh.rotation.x += shape.rotSpeed;
      shape.mesh.rotation.y += shape.rotSpeed * 0.7;
      shape.mesh.position.y += Math.sin(t * shape.floatSpeed + shape.floatOffset) * 0.003;
    });

    renderer.render(scene, camera);
  }

  window.addEventListener("resize", resize);
  resize();
  requestAnimationFrame(tick);
}

// Ripple effect for buttons
function createRipple(event) {
  const button = event.currentTarget;
  const ripple = document.createElement("span");
  const rect = button.getBoundingClientRect();
  const size = Math.max(rect.width, rect.height);
  const x = event.clientX - rect.left - size / 2;
  const y = event.clientY - rect.top - size / 2;

  ripple.style.width = ripple.style.height = `${size}px`;
  ripple.style.left = `${x}px`;
  ripple.style.top = `${y}px`;
  ripple.classList.add("ripple");

  const existingRipple = button.querySelector(".ripple");
  if (existingRipple) {
    existingRipple.remove();
  }

  button.appendChild(ripple);

  ripple.addEventListener("animationend", () => {
    ripple.remove();
  });
}

document.querySelectorAll(".ripple-btn").forEach(button => {
  button.addEventListener("click", createRipple);
});

// Initialize
window.addEventListener("resize", sizeWave);
sizeWave();
requestAnimationFrame(drawWave);
initAmbient();
