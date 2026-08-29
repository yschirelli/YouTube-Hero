// Audio Engine State
let userStats = { playHistory: [], playCounts: {}, favorites: [], highScores: {} };

window.gameAPI.loadUserStats().then(stats => {
    if (stats) userStats = stats;
    if (typeof renderHomeStats === 'function') renderHomeStats();
});

let audioCtx = null;
let analyser = null;
let source = null;
let audioPlayer = document.getElementById('local-audio-player');
let dataArray = null;

const lanes = 5;
const laneColors = ['#00ff00', '#ff0000', '#ffff00', '#0000ff', '#ffa500'];
let gameActive = false;
let isPaused = false;

let leadInActive = false;
let leadInStartTime = 0;
let leadInPausedElapsed = 0;
const LEAD_IN_SECONDS = 3.0;

function getGameTime() {
    let t = 0;
    if (leadInActive) {
        if (isPaused) return leadInPausedElapsed - LEAD_IN_SECONDS;
        const elapsed = (performance.now() - leadInStartTime) / 1000.0;
        t = elapsed - LEAD_IN_SECONDS;
        if (t >= 0) {
            leadInActive = false;
            audioPlayer.currentTime = 0;
            audioPlayer.play();
            if (isYtPlayerReady && ytPlayer && ytPlayer.playVideo) ytPlayer.playVideo();
            t = audioPlayer.currentTime;
        }
    } else {
        t = audioPlayer ? audioPlayer.currentTime : 0;
    }
    const offsetSeconds = (gameSettings.calibrationOffset || 0) / 1000.0;
    return t + offsetSeconds;
}

function formatDuration(val) {
    if (typeof val === 'string' && val.includes(':')) return val;
    const seconds = parseFloat(val);
    if (!seconds || isNaN(seconds)) return "Unknown";
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
}
function formatHighScore(num) {
    if (num === undefined || num === null) return '0';
    return num.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

function getFormattedHighScoreForSong(songId, diff) {
    let hs = 0;
    if (userStats && userStats.highScores && userStats.highScores[songId] && userStats.highScores[songId][diff]) {
        hs = userStats.highScores[songId][diff];
    }
    return formatHighScore(hs);
}

function updateCardHighScoreDisplay(songId) {
    const diff = getSongDifficulty(songId);
    const highscoreEls = document.querySelectorAll(`.search-result-highscore[data-song-id="${songId}"]`);
    highscoreEls.forEach(el => {
        el.textContent = `High Score: ${getFormattedHighScoreForSong(songId, diff)}`;
    });
}

function updateAllCardsHighScoreDisplays() {
    const highscoreEls = document.querySelectorAll('.search-result-highscore');
    highscoreEls.forEach(el => {
        const songId = el.getAttribute('data-song-id');
        if (songId) {
            const diff = getSongDifficulty(songId);
            el.textContent = `High Score: ${getFormattedHighScoreForSong(songId, diff)}`;
        }
    });
}


function playHitSound() {
    if (!audioCtx || !gameSettings.debugHitSound) return;
    try {
        const osc = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);

        osc.type = 'sine';
        osc.frequency.setValueAtTime(1000, audioCtx.currentTime);
        gain.gain.setValueAtTime(0.2, audioCtx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);

        osc.start(audioCtx.currentTime);
        osc.stop(audioCtx.currentTime + 0.05);
    } catch (e) {
        console.error("Failed to play hit sound:", e);
    }
}

// Game Settings State — must be declared early, before any draw calls
const defaultSettings = {
    uiScaleMultiplier: 1.0,

    laneFlashesEnabled: true,
    vocalSeparationEnabled: false,
    hudPosition: 'bottom-right',
    debugAutoplay: false,
    debugVisualizer: false,
    debugWaveform: false,
    debugRejected: false,
    calibrationOffset: 0,
    viewDuration: 1.5,
    hitWindow: 150,
    debugHitSound: false,
    debugHitboxes: false,
    debugFPS: false,
    debugNoteTimestamps: false,
    debugAudioSwitch: true,
    keyBinds: ['a', 's', 'j', 'k', 'l'],
    audioSwitchBind: 'q',
    saveLogsEnabled: false
};
let gameSettings = JSON.parse(JSON.stringify(defaultSettings));

const keyMap = {};
function updateKeyMap() {
    for (const k in keyMap) {
        delete keyMap[k];
    }
    if (gameSettings.keyBinds) {
        gameSettings.keyBinds.forEach((key, index) => {
            keyMap[key.toLowerCase()] = index;
            keyMap[key.toUpperCase()] = index;
        });
    }
}

function getKeyDisplay(key) {
    if (key === ' ') return 'SPACE';
    if (key.length > 1) return key.toUpperCase();
    return key.toUpperCase();
}

function updateKeybindButtons() {
    if (gameSettings.keyBinds) {
        gameSettings.keyBinds.forEach((key, index) => {
            const btn = document.getElementById(`keybind-btn-${index}`);
            if (btn) {
                btn.innerText = getKeyDisplay(key);
                btn.classList.remove('rebinding');
            }
        });
    }
    const audioBtn = document.getElementById('keybind-btn-audio');
    if (audioBtn && gameSettings.audioSwitchBind) {
        audioBtn.innerText = getKeyDisplay(gameSettings.audioSwitchBind);
        audioBtn.classList.remove('rebinding');
    }
}

let rebindingLaneIndex = null;
let rebindingAudioSwitch = false;
let sessionDifficulty = 'Medium';
let songDifficulties = {};
try {
    const savedDiffs = localStorage.getItem('ytHeroSongDifficulties');
    if (savedDiffs) {
        songDifficulties = JSON.parse(savedDiffs);
    }
} catch (e) {
    console.warn("Failed to load saved song difficulties:", e);
}

function getSongDifficulty(songId) {
    if (songId && songDifficulties[songId]) {
        return songDifficulties[songId];
    }
    return 'Medium';
}

function setSongDifficulty(songId, diff) {
    if (songId) {
        songDifficulties[songId] = diff;
        try {
            localStorage.setItem('ytHeroSongDifficulties', JSON.stringify(songDifficulties));
        } catch (e) {
            console.warn("Failed to save song difficulties:", e);
        }
    }
}
window.getSongDifficulty = getSongDifficulty;
window.setSongDifficulty = setSongDifficulty;
let score = 0;
let combo = 0;
let multiplier = 1;
let songMap = [];  // Will be populated by FFT or loaded from DB

let hitEffects = [];
let hitParticles = [];
let hitShockwaves = [];
let hitHistory = []; // { diffMs: number, color: string, timestamp: number }
let activeRatingIndicator = null; // { text: string, color: string, alpha: number, x: number, y: number }
let lastUserInputTime = 0; // timestamp in ms

function setRatingIndicator(text, color) {
    activeRatingIndicator = {
        text: text,
        color: color,
        alpha: 1.0,
        x: (typeof cw !== 'undefined' ? cw : window.innerWidth) / 2,
        y: 150
    };
    lastUserInputTime = performance.now();
}
let activeKeys = { 0: false, 1: false, 2: false, 3: false, 4: false };
let hasHitForCurrentPress = { 0: false, 1: false, 2: false, 3: false, 4: false };
let shakeAmount = 0;
let beatVolume = 0;
let lastMultiplier = 1;

// FPS Counter State
let lastFrameTime = performance.now();
let frameCount = 0;
let lastFpsUpdateTime = performance.now();
let currentFps = 60;
let currentFrameTimeMs = 16.6;

// Drawing Constantsp
let viewDuration = 1.5; // Seconds a note is visible before hit
const missWindow = 0.2; // Seconds note is visible after hit window
const horizonYRatio = 0.25; // 25% of screen height
const horizonWidthRatio = 0.15; // 15% of screen width at horizon
const hitWidthRatio = 0.6; // 60% of screen width at hit zone

// Canvas Setup
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');
let cw, ch, laneWidth;

function resize() {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    cw = canvas.width;
    ch = canvas.height;
    drawHighway(); // Draw highway immediately on resize to prevent initial black screen
}
window.addEventListener('resize', resize);
resize();

// UI Elements
const urlInput = document.getElementById('youtube-url-input');
const startBtn = document.getElementById('start-btn');
const uiLayer = document.getElementById('url-input-container');

function hideUILayer(callback) {
    uiLayer.classList.remove('panel-fade-out-menu');
    void uiLayer.offsetWidth;
    uiLayer.classList.add('panel-fade-out-menu');
    setTimeout(() => {
        uiLayer.style.display = 'none';
        uiLayer.classList.remove('panel-fade-out-menu');
        if (callback) callback();
    }, 400);
}

function showUILayer() {
    uiLayer.style.display = 'flex';
    uiLayer.style.animation = 'none';
    void uiLayer.offsetWidth;
    uiLayer.style.animation = '';
}

window.hideUILayer = hideUILayer;
window.showUILayer = showUILayer;
const searchResults = document.getElementById('search-results');
const cachedSongsList = document.getElementById('cached-songs-list');
const searchBarWrapper = document.getElementById('search-bar-wrapper');

const progressContainer = document.getElementById('progress-container');
const progressText = document.getElementById('progress-text');
const progressBarFill = document.getElementById('progress-bar-fill');

const pauseMenu = document.getElementById('pause-menu');
const resumeBtn = document.getElementById('resume-btn');
const restartBtn = document.getElementById('restart-btn');
const mainMenuBtn = document.getElementById('main-menu-btn');

const settingsBtn = document.getElementById('header-settings-btn');
const settingsModal = document.getElementById('settings-modal');
const closeSettingsBtn = document.getElementById('close-settings-btn');
const laneFlashesToggle = document.getElementById('lane-flashes-toggle');
const hudPositionSelect = document.getElementById('hud-position-select');
const uiScaleSlider = document.getElementById('ui-scale-slider');
const uiScaleValue = document.getElementById('ui-scale-value');
const uiScaleApplyBtn = document.getElementById('ui-scale-apply-btn');

// In-game control buttons
const ingameSettingsBtn = document.getElementById('ingame-settings-btn');
const switchAudioBtn = document.getElementById('switch-audio-btn');
const pauseSettingsBtn = document.getElementById('pause-settings-btn');
const switchAudioPauseBtn = document.getElementById('switch-audio-pause-btn');
const audioSourceBadge = document.getElementById('audio-source-badge');

let settingsOpenedFromGame = false;  // Track if settings was opened mid-game


const clearLogsBtn = document.getElementById('clear-logs-btn');
const deleteAllCacheBtn = document.getElementById('delete-all-cache-btn');
const clearSaveDataBtn = document.getElementById('clear-save-data-btn');
const debugAutoplayToggle = document.getElementById('debug-autoplay-toggle');
const debugVisualizerToggle = document.getElementById('debug-visualizer-toggle');
const debugWaveformToggle = document.getElementById('debug-waveform-toggle');
const debugRejectedToggle = document.getElementById('debug-rejected-toggle');
const debugFpsToggle = document.getElementById('debug-fps-toggle');
const debugHitboxesToggle = document.getElementById('debug-hitboxes-toggle');
const debugNoteTimestampsToggle = document.getElementById('debug-note-timestamps-toggle');
const debugAudioSwitchToggle = document.getElementById('debug-audio-switch-toggle');
const debugHitSoundToggle = document.getElementById('debug-hitsound-toggle');

// Audio Track Switcher State
let originalAudioUrl = null;
let beatgenAudioUrl = null;
let currentAudioTrack = 'original'; // 'original' | 'beatgen'
const debugCalibrationSlider = document.getElementById('debug-calibration-slider');
const debugCalibrationValue = document.getElementById('debug-calibration-value');
const debugScrollSlider = document.getElementById('debug-scroll-slider');
const debugScrollValue = document.getElementById('debug-scroll-value');
const debugHitwindowSlider = document.getElementById('debug-hitwindow-slider');
const debugHitwindowValue = document.getElementById('debug-hitwindow-value');

const diffRadios = document.querySelectorAll('input[name="difficulty"]');
diffRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        sessionDifficulty = e.target.value;
        console.log(`[UI] Difficulty set to ${sessionDifficulty}`);
    });
});

// (gameSettings declared at top of file)

// Load settings from localStorage
function loadSettings() {
    const saved = localStorage.getItem('ytHeroSettings');
    if (saved) {
        try {
            const parsed = JSON.parse(saved);
            // Only load non-debug settings from localStorage.
            // Debug options always start OFF on every launch.

            gameSettings.laneFlashesEnabled = parsed.laneFlashesEnabled !== undefined ? parsed.laneFlashesEnabled : defaultSettings.laneFlashesEnabled;
            gameSettings.vocalSeparationEnabled = parsed.vocalSeparationEnabled !== undefined ? parsed.vocalSeparationEnabled : defaultSettings.vocalSeparationEnabled;
            gameSettings.hudPosition = parsed.hudPosition || defaultSettings.hudPosition;
            gameSettings.uiScaleMultiplier = parsed.uiScaleMultiplier || defaultSettings.uiScaleMultiplier;

            // Load and persist gameplay calibration / speed settings
            gameSettings.calibrationOffset = parsed.calibrationOffset !== undefined ? parsed.calibrationOffset : defaultSettings.calibrationOffset;
            gameSettings.viewDuration = parsed.viewDuration !== undefined ? parsed.viewDuration : defaultSettings.viewDuration;
            viewDuration = gameSettings.viewDuration; // update global travel speed
            gameSettings.hitWindow = parsed.hitWindow !== undefined ? parsed.hitWindow : defaultSettings.hitWindow;
            gameSettings.keyBinds = parsed.keyBinds || [...defaultSettings.keyBinds];
            gameSettings.audioSwitchBind = parsed.audioSwitchBind || defaultSettings.audioSwitchBind;
            gameSettings.saveLogsEnabled = parsed.saveLogsEnabled !== undefined ? parsed.saveLogsEnabled : defaultSettings.saveLogsEnabled;
            gameSettings.debugAudioSwitch = parsed.debugAudioSwitch !== undefined ? parsed.debugAudioSwitch : defaultSettings.debugAudioSwitch;

            // Force all debug options off on startup
            gameSettings.debugAutoplay = false;
            gameSettings.debugVisualizer = false;
            gameSettings.debugWaveform = false;
            gameSettings.debugRejected = false;
            gameSettings.debugHitSound = false;
            gameSettings.debugHitboxes = false;
            gameSettings.debugFPS = false;
            gameSettings.debugNoteTimestamps = false;
        } catch (e) {
            console.error("Failed to load settings", e);
        }
    } else {
        gameSettings = JSON.parse(JSON.stringify(defaultSettings));
        viewDuration = gameSettings.viewDuration;
    }

    // Always update UI controls to match current state
    if (window.gameAPI && window.gameAPI.setZoomFactor) {
        window.gameAPI.setZoomFactor(gameSettings.uiScaleMultiplier);
    }

    if (laneFlashesToggle) laneFlashesToggle.checked = gameSettings.laneFlashesEnabled;
    const vocalSeparationToggle = document.getElementById('vocal-separation-toggle');
    if (vocalSeparationToggle) vocalSeparationToggle.checked = gameSettings.vocalSeparationEnabled;
    const saveLogsToggle = document.getElementById('save-logs-toggle');
    if (saveLogsToggle) saveLogsToggle.checked = gameSettings.saveLogsEnabled;
    if (debugAudioSwitchToggle) debugAudioSwitchToggle.checked = gameSettings.debugAudioSwitch;
    if (hudPositionSelect) {
        hudPositionSelect.value = gameSettings.hudPosition;
        applyHudPosition(gameSettings.hudPosition);
    }
    if (uiScaleSlider) {
        uiScaleSlider.value = gameSettings.uiScaleMultiplier;
        if (uiScaleValue) uiScaleValue.innerText = `${gameSettings.uiScaleMultiplier.toFixed(1)}x`;
    }
    if (debugAutoplayToggle) debugAutoplayToggle.checked = false;
    if (debugVisualizerToggle) debugVisualizerToggle.checked = false;
    if (debugWaveformToggle) debugWaveformToggle.checked = false;
    if (debugRejectedToggle) debugRejectedToggle.checked = false;
    if (debugFpsToggle) debugFpsToggle.checked = false;
    if (debugHitboxesToggle) debugHitboxesToggle.checked = false;
    if (debugNoteTimestampsToggle) debugNoteTimestampsToggle.checked = false;
    if (debugHitSoundToggle) debugHitSoundToggle.checked = false;

    if (debugCalibrationSlider) {
        debugCalibrationSlider.value = gameSettings.calibrationOffset;
        if (debugCalibrationValue) debugCalibrationValue.innerText = `${gameSettings.calibrationOffset > 0 ? '+' : ''}${gameSettings.calibrationOffset}ms`;
    }
    if (debugScrollSlider) {
        debugScrollSlider.value = gameSettings.viewDuration;
        if (debugScrollValue) debugScrollValue.innerText = `${gameSettings.viewDuration.toFixed(1)}s`;
    }
    if (debugHitwindowSlider) {
        debugHitwindowSlider.value = gameSettings.hitWindow;
        if (debugHitwindowValue) debugHitwindowValue.innerText = `${gameSettings.hitWindow}ms`;
    }

    updateKeyMap();
    updateKeybindButtons();
}
loadSettings();

function saveSettings() {
    localStorage.setItem('ytHeroSettings', JSON.stringify(gameSettings));
    if (window.gameAPI && window.gameAPI.saveSettings) {
        window.gameAPI.saveSettings(gameSettings);
    }
}

// Settings Listeners
function initSettingsTabs() {
    const tabBtns = document.querySelectorAll('.settings-tab-btn');
    const tabPanes = document.querySelectorAll('.settings-tab-pane');

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const targetTabId = btn.getAttribute('data-tab');

            // Deactivate all buttons and panes
            tabBtns.forEach(b => b.classList.remove('active'));
            tabPanes.forEach(p => {
                p.classList.remove('active');
                p.classList.remove('show-active');
            });

            // Activate clicked button
            btn.classList.add('active');

            // Activate and fade-in target pane
            const pane = document.getElementById(targetTabId);
            if (pane) {
                pane.classList.add('active');
                void pane.offsetWidth; // Force reflow to register display: block
                pane.classList.add('show-active');
            }
        });
    });
}
initSettingsTabs();

function showSettingsModal() {
    // Reset tabs to first tab, or trigger click on active tab to ensure correct initial state and transition
    const activeBtn = document.querySelector('.settings-tab-btn.active');
    if (activeBtn) {
        activeBtn.click();
    } else {
        const firstTab = document.querySelector('.settings-tab-btn');
        if (firstTab) firstTab.click();
    }

    settingsModal.style.display = 'flex';
    void settingsModal.offsetWidth; // Force browser reflow to trigger CSS transition
    settingsModal.classList.add('show');
}

function hideSettingsModal() {
    settingsModal.classList.remove('show');
    setTimeout(() => {
        if (!settingsModal.classList.contains('show')) {
            settingsModal.style.display = 'none';
        }
    }, 300);
}

// Settings Listeners
// Main-menu settings button (from the home screen)
settingsBtn.addEventListener('click', () => {
    settingsOpenedFromGame = false;
    showSettingsModal();
});

// In-game gear button (pauses game and opens settings)
if (ingameSettingsBtn) {
    ingameSettingsBtn.addEventListener('click', () => {
        if (gameActive && !isPaused) togglePause();
        settingsOpenedFromGame = true;
        showSettingsModal();
    });
}

// Pause-menu settings button
if (pauseSettingsBtn) {
    pauseSettingsBtn.addEventListener('click', () => {
        settingsOpenedFromGame = true;
        showSettingsModal();
    });
}

closeSettingsBtn.addEventListener('click', () => {
    hideSettingsModal();

    // Revert slider if closed without applying
    if (uiScaleSlider) {
        uiScaleSlider.value = gameSettings.uiScaleMultiplier;
        if (uiScaleValue) uiScaleValue.innerText = `${gameSettings.uiScaleMultiplier.toFixed(1)}x`;
        if (uiScaleApplyBtn) {
            uiScaleApplyBtn.disabled = true;
            uiScaleApplyBtn.style.opacity = '0.5';
            uiScaleApplyBtn.style.cursor = 'not-allowed';
        }
    }

    // If settings was opened mid-game and we weren't in the pause menu,
    // restore game by resuming (if paused for settings)
    if (settingsOpenedFromGame && gameActive && isPaused) {
        // Don't auto-resume — leave pause menu visible so user can decide
        pauseMenu.style.display = 'flex';
    }
    settingsOpenedFromGame = false;
});

if (laneFlashesToggle) {
    laneFlashesToggle.addEventListener('change', (e) => {
        gameSettings.laneFlashesEnabled = e.target.checked;
        saveSettings();
    });
}

function applyHudPosition(pos) {
    const stats = document.getElementById('game-stats');
    if (stats) {
        stats.classList.remove('hud-top-right', 'hud-bottom-left', 'hud-bottom-right', 'hud-top-left');
        stats.classList.add(`hud-${pos}`);
    }
}

if (hudPositionSelect) {
    hudPositionSelect.addEventListener('change', (e) => {
        gameSettings.hudPosition = e.target.value;
        applyHudPosition(gameSettings.hudPosition);
        saveSettings();
    });
}

if (uiScaleSlider) {
    uiScaleSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        if (uiScaleValue) uiScaleValue.innerText = `${val.toFixed(1)}x`;
        if (uiScaleApplyBtn) {
            if (val !== gameSettings.uiScaleMultiplier) {
                uiScaleApplyBtn.disabled = false;
                uiScaleApplyBtn.style.opacity = '1';
                uiScaleApplyBtn.style.cursor = 'pointer';
            } else {
                uiScaleApplyBtn.disabled = true;
                uiScaleApplyBtn.style.opacity = '0.5';
                uiScaleApplyBtn.style.cursor = 'not-allowed';
            }
        }
    });

    if (uiScaleApplyBtn) {
        uiScaleApplyBtn.addEventListener('click', () => {
            gameSettings.uiScaleMultiplier = parseFloat(uiScaleSlider.value);
            if (window.gameAPI && window.gameAPI.setZoomFactor) {
                window.gameAPI.setZoomFactor(gameSettings.uiScaleMultiplier);
            }
            saveSettings();
            uiScaleApplyBtn.disabled = true;
            uiScaleApplyBtn.style.opacity = '0.5';
            uiScaleApplyBtn.style.cursor = 'not-allowed';
        });
    }
}

if (clearLogsBtn) {
    clearLogsBtn.addEventListener('click', async () => {
        if (confirm("Are you sure you want to delete all log files?")) {
            await window.gameAPI.clearAllLogs();
            alert("All debug logs have been cleared.");
        }
    });
}

if (deleteAllCacheBtn) {
    deleteAllCacheBtn.addEventListener('click', async () => {
        if (confirm("Are you sure you want to delete ALL cached songs from the disk? This will also remove their associated beat algorithm data.")) {
            await window.gameAPI.deleteAllCachedSongs();
            if (typeof updateCachedSongsList === 'function') updateCachedSongsList();
            alert("All cached songs have been deleted.");
        }
    });
}

if (clearSaveDataBtn) {
    clearSaveDataBtn.addEventListener('click', async () => {
        if (confirm("WARNING: This will wipe all your game progress, including Favorites, Recently Played, High Scores, and Play Counts. This cannot be undone. Are you sure?")) {
            userStats = { playHistory: [], playCounts: {}, favorites: [], highScores: {} };
            await window.gameAPI.saveUserStats(userStats);

            // Clear relevant localStorage items
            localStorage.removeItem('ytHeroLastSong');

            // Refresh UI
            if (typeof renderHomeStats === 'function') renderHomeStats();
            if (typeof updateCachedSongsList === 'function') updateCachedSongsList();

            alert("All game save data has been cleared.");
        }
    });
}

if (debugAutoplayToggle) {
    debugAutoplayToggle.addEventListener('change', (e) => { gameSettings.debugAutoplay = e.target.checked; saveSettings(); });
}
const saveLogsToggle = document.getElementById('save-logs-toggle');
if (saveLogsToggle) {
    saveLogsToggle.addEventListener('change', (e) => { gameSettings.saveLogsEnabled = e.target.checked; saveSettings(); });
}
const vocalSeparationToggle = document.getElementById('vocal-separation-toggle');
if (vocalSeparationToggle) {
    vocalSeparationToggle.addEventListener('change', (e) => { gameSettings.vocalSeparationEnabled = e.target.checked; saveSettings(); });
}
if (debugVisualizerToggle) {
    debugVisualizerToggle.addEventListener('change', (e) => { gameSettings.debugVisualizer = e.target.checked; saveSettings(); });
}
if (debugWaveformToggle) {
    debugWaveformToggle.addEventListener('change', (e) => { gameSettings.debugWaveform = e.target.checked; saveSettings(); });
}
if (debugRejectedToggle) {
    debugRejectedToggle.addEventListener('change', (e) => { gameSettings.debugRejected = e.target.checked; saveSettings(); });
}
if (debugFpsToggle) {
    debugFpsToggle.addEventListener('change', (e) => { gameSettings.debugFPS = e.target.checked; saveSettings(); });
}
if (debugHitboxesToggle) {
    debugHitboxesToggle.addEventListener('change', (e) => { gameSettings.debugHitboxes = e.target.checked; saveSettings(); });
}
if (debugNoteTimestampsToggle) {
    debugNoteTimestampsToggle.addEventListener('change', (e) => { gameSettings.debugNoteTimestamps = e.target.checked; saveSettings(); });
}
if (debugAudioSwitchToggle) {
    debugAudioSwitchToggle.addEventListener('change', (e) => {
        gameSettings.debugAudioSwitch = e.target.checked;
        saveSettings();
        updateAudioTrackIndicator();
    });
}
if (debugHitSoundToggle) {
    debugHitSoundToggle.addEventListener('change', (e) => { gameSettings.debugHitSound = e.target.checked; saveSettings(); });
}
if (debugCalibrationSlider) {
    debugCalibrationSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        if (debugCalibrationValue) debugCalibrationValue.innerText = `${val > 0 ? '+' : ''}${val}ms`;
        gameSettings.calibrationOffset = val;
        saveSettings();
    });
}
if (debugScrollSlider) {
    debugScrollSlider.addEventListener('input', (e) => {
        const val = parseFloat(e.target.value);
        if (debugScrollValue) debugScrollValue.innerText = `${val.toFixed(1)}s`;
        gameSettings.viewDuration = val;
        viewDuration = val; // apply immediately
        saveSettings();
    });
}
if (debugHitwindowSlider) {
    debugHitwindowSlider.addEventListener('input', (e) => {
        const val = parseInt(e.target.value);
        if (debugHitwindowValue) debugHitwindowValue.innerText = `${val}ms`;
        gameSettings.hitWindow = val;
        saveSettings();
    });
}

// Note Key Rebinding Click Listeners
const keybindBtns = [
    document.getElementById('keybind-btn-0'),
    document.getElementById('keybind-btn-1'),
    document.getElementById('keybind-btn-2'),
    document.getElementById('keybind-btn-3'),
    document.getElementById('keybind-btn-4')
];

keybindBtns.forEach((btn, index) => {
    if (btn) {
        btn.addEventListener('click', (e) => {
            e.stopPropagation();

            // Cancel any active rebinding on other buttons
            if (rebindingLaneIndex !== null) {
                const prevBtn = document.getElementById(`keybind-btn-${rebindingLaneIndex}`);
                if (prevBtn) {
                    prevBtn.innerText = getKeyDisplay(gameSettings.keyBinds[rebindingLaneIndex]);
                    prevBtn.classList.remove('rebinding');
                }
            }
            if (rebindingAudioSwitch) {
                const prevBtn = document.getElementById('keybind-btn-audio');
                if (prevBtn) {
                    prevBtn.innerText = getKeyDisplay(gameSettings.audioSwitchBind);
                    prevBtn.classList.remove('rebinding');
                }
                rebindingAudioSwitch = false;
            }

            rebindingLaneIndex = index;
            btn.innerText = 'PRESS...';
            btn.classList.add('rebinding');
        });
    }
});

const audioKeybindBtn = document.getElementById('keybind-btn-audio');
if (audioKeybindBtn) {
    audioKeybindBtn.addEventListener('click', (e) => {
        e.stopPropagation();

        // Cancel any active lane keybind rebinding
        if (rebindingLaneIndex !== null) {
            const prevBtn = document.getElementById(`keybind-btn-${rebindingLaneIndex}`);
            if (prevBtn) {
                prevBtn.innerText = getKeyDisplay(gameSettings.keyBinds[rebindingLaneIndex]);
                prevBtn.classList.remove('rebinding');
            }
            rebindingLaneIndex = null;
        }

        rebindingAudioSwitch = true;
        audioKeybindBtn.innerText = 'PRESS...';
        audioKeybindBtn.classList.add('rebinding');
    });
}

// Reset Settings Listener
const resetSettingsBtn = document.getElementById('reset-settings-btn');
if (resetSettingsBtn) {
    resetSettingsBtn.addEventListener('click', () => {
        if (confirm("Are you sure you want to reset all settings back to their default values?")) {
            // Cancel keybind rebinding if active
            if (rebindingLaneIndex !== null) {
                rebindingLaneIndex = null;
            }
            rebindingAudioSwitch = false;
            gameSettings = JSON.parse(JSON.stringify(defaultSettings));
            saveSettings();
            loadSettings(); // This will apply all defaults to the UI elements
            alert("All settings have been restored to their defaults.");
        }
    });
}



async function deleteCachedSongWrapper(videoId) {
    if (confirm('Are you sure you want to delete this downloaded song?')) {
        await window.gameAPI.deleteCachedSong(videoId);
        updateCachedSongsList();
    }
}

function createCachedSongElement(song) {
    const resultDiv = document.createElement('div');
    resultDiv.className = 'search-result';

    const isFav = userStats.favorites.some(f => f.id === song.id);
    const favIcon = isFav ? 'star' : 'star_border';
    const favColor = isFav ? '#ffd700' : '#888';

    // Build difficulty badges
    const difficulties = song.cachedDifficulties || [];
    let diffBadges = '';

    if (difficulties.length === 0) {
        diffBadges = '<span class="cached-diff-badge cached-diff-unknown">?</span>';
    } else {
        difficulties.sort((a, b) => {
            const order = { 'Easy': 0, 'Medium': 1, 'Hard': 2, 'Insane': 3 };
            return order[a] - order[b];
        }).forEach(diff => {
            let className = 'cached-diff-unknown';
            if (diff === 'Easy') className = 'cached-diff-easy';
            else if (diff === 'Medium') className = 'cached-diff-medium';
            else if (diff === 'Hard') className = 'cached-diff-hard';
            else if (diff === 'Insane') className = 'cached-diff-insane';
            diffBadges += `<span class="cached-diff-badge ${className}">${diff}</span> `;
        });
    }

    const tempoBadge = song.tempo
        ? `<span class="cached-tempo-badge" style="background: rgba(255, 145, 0, 0.15); color: #ff9100; border: 1px solid rgba(255, 145, 0, 0.3); border-radius: 4px; padding: 2px 6px; font-size: 11px; font-weight: bold; display: inline-flex; align-items: center; gap: 4px;"><span class="material-icons" style="font-size: 12px; margin-top: -1px;">speed</span>${Math.round(song.tempo)} BPM</span>`
        : '';

    resultDiv.innerHTML = `
        <div class="search-result-content">
            <img src="${song.thumbnail}" alt="thumbnail">
            <div class="search-result-info">
                <div class="search-result-title"></div>
                <div class="search-result-artist" style="color: var(--primary-accent); display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                    Cached Locally ${diffBadges} ${tempoBadge}
                </div>
                <div class="search-result-highscore" data-song-id="${song.id}" style="font-size: 13px; color: var(--primary-accent); opacity: 0.85; font-weight: 500; margin-top: 2px;">
                    High Score: ${getFormattedHighScoreForSong(song.id, getSongDifficulty(song.id))}
                </div>
                <div class="inline-diff-control" data-song-id="${song.id}">
                    <button class="diff-btn easy ${getSongDifficulty(song.id) === 'Easy' ? 'active' : ''}">EASY</button>
                    <button class="diff-btn medium ${getSongDifficulty(song.id) === 'Medium' ? 'active' : ''}">MEDIUM</button>
                    <button class="diff-btn hard ${getSongDifficulty(song.id) === 'Hard' ? 'active' : ''}">HARD</button>
                    <button class="diff-btn insane ${getSongDifficulty(song.id) === 'Insane' ? 'active' : ''}">INSANE</button>
                </div>
            </div>
        </div>
        <div class="cached-song-actions" style="display: flex; flex-direction: row; gap: 8px; align-items: center; padding-right: 15px;">
            <span class="material-icons fav-btn" style="color: ${favColor}; cursor: pointer; font-size: 28px;" title="Favorite">${favIcon}</span>
            <button class="cache-icon-btn rename-btn" title="Rename"><span class="material-icons" style="font-size: 16px;">edit</span></button>
            <button class="cache-icon-btn regen-btn" title="Regenerate Beatmap"><span class="material-icons" style="font-size: 16px;">autorenew</span></button>
            <button class="cache-icon-btn del-btn" title="Delete"><span class="material-icons" style="font-size: 16px;">delete</span></button>
        </div>
    `;

    // Set textContent to prevent HTML injection and escaping bugs
    resultDiv.querySelector('.search-result-title').textContent = song.title;

    // Bind event listeners using JS references
    resultDiv.onclick = () => window.selectSong(song.id, song.title, song.thumbnail, song.duration || "Unknown Duration", true, song.tempo);

    // Difficulty buttons
    const diffBtns = resultDiv.querySelectorAll('.diff-btn');
    diffBtns.forEach(btn => {
        btn.onclick = (e) => {
            e.stopPropagation();
            const diffName = btn.innerText.charAt(0) + btn.innerText.slice(1).toLowerCase();
            window.setDifficulty(diffName, btn.parentElement, song.id);
        };
    });

    // Favorite button
    const favBtn = resultDiv.querySelector('.fav-btn');
    favBtn.onclick = (e) => {
        e.stopPropagation();
        window.toggleFavorite(song.id, favBtn);
    };

    // Rename button
    const renameBtn = resultDiv.querySelector('.rename-btn');
    renameBtn.onclick = (e) => {
        e.stopPropagation();
        window.renameCachedSong(song.id);
    };

    // Regen button
    const regenBtn = resultDiv.querySelector('.regen-btn');
    regenBtn.onclick = (e) => {
        e.stopPropagation();
        window.hideUILayer(() => {
            initGame(song.id, song.title, song.thumbnail, song.duration || 'Unknown', true);
        });
    };

    // Delete button
    const delBtn = resultDiv.querySelector('.del-btn');
    delBtn.onclick = (e) => {
        e.stopPropagation();
        deleteCachedSongWrapper(song.id);
    };

    return resultDiv;
}

function getSongSection(title) {
    if (!title) return '#';
    const firstChar = title.trim().charAt(0).toUpperCase();
    if (/[A-Z0-9]/.test(firstChar)) {
        return firstChar;
    }
    return '#';
}

async function updateCachedSongsList() {
    const songs = await window.gameAPI.getCachedSongs();
    cachedSongsList.innerHTML = '';
    if (songs.length === 0) {
        cachedSongsList.innerHTML = '<div style="color: #888;">No cached songs yet.</div>';
    } else {
        // Sort songs first
        songs.sort((a, b) => {
            const tA = (a.title || '').toLowerCase();
            const tB = (b.title || '').toLowerCase();
            return tA.localeCompare(tB);
        });

        // 1. Render Favorites section at the top if there are favorites
        const favoriteSongs = songs.filter(song => userStats.favorites.some(f => f.id === song.id));
        if (favoriteSongs.length > 0) {
            // Create FAVORITES separator element
            const favoritesSeparatorDiv = document.createElement('div');
            favoritesSeparatorDiv.className = 'song-library-separator favorites-separator';
            favoritesSeparatorDiv.innerHTML = '<span class="material-icons" style="font-size:18px; vertical-align: middle; margin-right: 4px; color: #ffd700;">star</span>FAVORITES';
            cachedSongsList.appendChild(favoritesSeparatorDiv);

            // Render each favorite song
            favoriteSongs.forEach(song => {
                const resultDiv = createCachedSongElement(song);
                cachedSongsList.appendChild(resultDiv);
            });
        }

        // 2. Render normal alphabetical/numerical groups below
        const groups = {};
        songs.forEach(song => {
            const section = getSongSection(song.title);
            if (!groups[section]) {
                groups[section] = [];
            }
            groups[section].push(song);
        });

        const sortedSections = Object.keys(groups).sort((a, b) => {
            if (a === '#') return 1;
            if (b === '#') return -1;
            return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
        });

        sortedSections.forEach(section => {
            // Create separator element
            const separatorDiv = document.createElement('div');
            separatorDiv.className = 'song-library-separator';
            separatorDiv.innerText = section;
            cachedSongsList.appendChild(separatorDiv);

            // Render each song in the section
            groups[section].forEach(song => {
                const resultDiv = createCachedSongElement(song);
                cachedSongsList.appendChild(resultDiv);
            });
        });
    }
}
updateCachedSongsList();

if (window.gameAPI && typeof window.gameAPI.onCachedSongsUpdated === 'function') {
    window.gameAPI.onCachedSongsUpdated(() => {
        updateCachedSongsList();
    });
}

function customPrompt(titleText, defaultValue, callback) {
    // Create modal background
    const modalBg = document.createElement('div');
    modalBg.style.position = 'fixed';
    modalBg.style.top = '0';
    modalBg.style.left = '0';
    modalBg.style.width = '100%';
    modalBg.style.height = '100%';
    modalBg.style.backgroundColor = 'rgba(0, 0, 0, 0.8)';
    modalBg.style.backdropFilter = 'blur(10px)';
    modalBg.style.display = 'flex';
    modalBg.style.justifyContent = 'center';
    modalBg.style.alignItems = 'center';
    modalBg.style.zIndex = '99999';

    // Create modal container
    const modalContainer = document.createElement('div');
    modalContainer.style.background = 'rgba(10, 25, 30, 0.95)';
    modalContainer.style.border = '1px solid var(--primary-accent)';
    modalContainer.style.borderRadius = '16px';
    modalContainer.style.padding = '30px';
    modalContainer.style.width = '450px';
    modalContainer.style.boxShadow = '0 0 30px rgba(0, 229, 255, 0.2)';
    modalContainer.style.display = 'flex';
    modalContainer.style.flexDirection = 'column';
    modalContainer.style.gap = '20px';

    // Title
    const title = document.createElement('h3');
    title.innerText = titleText;
    title.style.margin = '0';
    title.style.fontFamily = "'Outfit', sans-serif";
    title.style.fontSize = '20px';
    title.style.color = '#fff';
    title.style.textTransform = 'uppercase';
    title.style.letterSpacing = '1px';
    modalContainer.appendChild(title);

    // Input field
    const input = document.createElement('input');
    input.type = 'text';
    input.value = defaultValue;
    input.style.background = 'rgba(255, 255, 255, 0.05)';
    input.style.border = '1px solid rgba(255, 255, 255, 0.1)';
    input.style.borderRadius = '8px';
    input.style.padding = '12px 16px';
    input.style.color = '#fff';
    input.style.fontSize = '16px';
    input.style.fontFamily = "'Inter', sans-serif";
    input.style.outline = 'none';
    input.style.transition = 'all 0.3s';
    input.onfocus = () => {
        input.style.borderColor = 'var(--primary-accent)';
        input.style.boxShadow = '0 0 10px rgba(0, 229, 255, 0.2)';
    };
    input.onblur = () => {
        input.style.borderColor = 'rgba(255, 255, 255, 0.1)';
        input.style.boxShadow = 'none';
    };
    modalContainer.appendChild(input);

    // Button Row
    const buttonRow = document.createElement('div');
    buttonRow.style.display = 'flex';
    buttonRow.style.justifyContent = 'flex-end';
    buttonRow.style.gap = '10px';

    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'pause-btn';
    cancelBtn.innerText = 'Cancel';
    cancelBtn.style.padding = '8px 20px';
    cancelBtn.style.fontSize = '14px';
    cancelBtn.style.margin = '0';
    cancelBtn.style.backgroundColor = 'transparent';
    cancelBtn.style.color = '#888';
    cancelBtn.style.borderColor = '#444';
    cancelBtn.style.cursor = 'pointer';
    cancelBtn.onclick = () => {
        document.body.removeChild(modalBg);
    };

    const confirmBtn = document.createElement('button');
    confirmBtn.className = 'pause-btn';
    confirmBtn.innerText = 'Save';
    confirmBtn.style.padding = '8px 20px';
    confirmBtn.style.fontSize = '14px';
    confirmBtn.style.margin = '0';
    confirmBtn.style.backgroundColor = 'var(--primary-accent)';
    confirmBtn.style.color = '#000';
    confirmBtn.style.borderColor = 'var(--primary-accent)';
    confirmBtn.style.cursor = 'pointer';
    confirmBtn.onclick = () => {
        const value = input.value.trim();
        document.body.removeChild(modalBg);
        callback(value);
    };

    // Enter key triggers confirm
    input.onkeydown = (e) => {
        if (e.key === 'Enter') {
            confirmBtn.click();
        } else if (e.key === 'Escape') {
            cancelBtn.click();
        }
    };

    buttonRow.appendChild(cancelBtn);
    buttonRow.appendChild(confirmBtn);
    modalContainer.appendChild(buttonRow);
    modalBg.appendChild(modalContainer);
    document.body.appendChild(modalBg);

    // Focus input
    setTimeout(() => {
        input.focus();
        input.select();
    }, 50);
}

window.renameCachedSong = async function (videoId) {
    const songs = await window.gameAPI.getCachedSongs();
    const song = songs.find(s => s.id === videoId);
    if (!song) return;

    customPrompt("Rename Song", song.title, async (trimmedTitle) => {
        if (!trimmedTitle) {
            alert("Song title cannot be empty.");
            return;
        }

        // Save locally to cache_index.json via IPC
        await window.gameAPI.saveCachedSong({ id: videoId, title: trimmedTitle });

        // Update title in userStats favorites and playHistory
        let statsChanged = false;
        userStats.favorites.forEach(f => {
            if (f.id === videoId) {
                f.title = trimmedTitle;
                statsChanged = true;
            }
        });
        userStats.playHistory.forEach(h => {
            if (h.id === videoId) {
                h.title = trimmedTitle;
                statsChanged = true;
            }
        });

        if (statsChanged) {
            await window.gameAPI.saveUserStats(userStats);
            if (typeof renderHomeStats === 'function') renderHomeStats();
        }

        // Refresh the UI
        updateCachedSongsList();
    });
};

window.renderHomeStats = function () {
    const recentlyPlayedList = document.getElementById('recently-played-list');
    const mostPlayedList = document.getElementById('most-played-list');
    const favoriteSongsList = document.getElementById('favorite-songs-list');

    if (!recentlyPlayedList) return;

    const createSongCard = (song, isFav) => {
        const resultDiv = document.createElement('div');
        resultDiv.className = 'search-result stagger-in';
        let escTitle = song.title ? song.title.replace(/'/g, "\\'") : 'Unknown';

        const favIcon = isFav ? 'star' : 'star_border';
        const favColor = isFav ? '#ffd700' : '#888';

        resultDiv.innerHTML = `
            <div class="search-result-content">
                <img src="${song.thumbnail}" alt="thumbnail">
                <div class="search-result-info">
                    <div class="search-result-title">${song.title}</div>
                    <div class="search-result-artist">Duration: ${song.duration || 'Unknown'}</div>
                    <div class="search-result-highscore" data-song-id="${song.id}" style="font-size: 13px; color: var(--primary-accent); opacity: 0.85; font-weight: 500; margin-top: 2px;">
                        High Score: ${getFormattedHighScoreForSong(song.id, getSongDifficulty(song.id))}
                    </div>
                    <div class="inline-diff-control" data-song-id="${song.id}">
                        <button class="diff-btn easy ${getSongDifficulty(song.id) === 'Easy' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDifficulty('Easy', this.parentElement, '${song.id}');">EASY</button>
                        <button class="diff-btn medium ${getSongDifficulty(song.id) === 'Medium' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDifficulty('Medium', this.parentElement, '${song.id}');">MEDIUM</button>
                        <button class="diff-btn hard ${getSongDifficulty(song.id) === 'Hard' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDifficulty('Hard', this.parentElement, '${song.id}');">HARD</button>
                        <button class="diff-btn insane ${getSongDifficulty(song.id) === 'Insane' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDifficulty('Insane', this.parentElement, '${song.id}');">INSANE</button>
                    </div>
                </div>
            </div>
            <div class="cached-song-actions" style="justify-content: center;">
                <span class="material-icons fav-btn" style="color: ${favColor}; cursor: pointer; font-size: 32px;" onclick="event.stopPropagation(); window.toggleFavorite('${song.id}', this)">${favIcon}</span>
            </div>
        `;
        resultDiv.onclick = () => window.selectSong(song.id, escTitle, song.thumbnail, song.duration, true);
        return resultDiv;
    };

    recentlyPlayedList.innerHTML = '';
    const recentUnique = [];
    const seen = new Set();
    for (let s of userStats.playHistory) {
        if (!seen.has(s.id)) {
            seen.add(s.id);
            recentUnique.push(s);
            if (recentUnique.length >= 10) break;
        }
    }
    if (recentUnique.length === 0) recentlyPlayedList.innerHTML = '<div style="color: #888; padding: 10px;">No recent songs.</div>';
    else recentUnique.forEach((s, i) => {
        const el = createSongCard(s, userStats.favorites.some(f => f.id === s.id));
        el.style.animationDelay = `${i * 0.05}s`;
        recentlyPlayedList.appendChild(el);
    });

    favoriteSongsList.innerHTML = '';
    if (userStats.favorites.length === 0) favoriteSongsList.innerHTML = '<div style="color: #888; padding: 10px;">No favorite songs yet. Click the star icon to favorite a song!</div>';
    else userStats.favorites.forEach((s, i) => {
        const el = createSongCard(s, true);
        el.style.animationDelay = `${i * 0.05}s`;
        favoriteSongsList.appendChild(el);
    });

    mostPlayedList.innerHTML = '';
    const mostPlayedIds = Object.entries(userStats.playCounts)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10)
        .map(e => e[0]);

    const mostPlayedSongs = [];
    for (let id of mostPlayedIds) {
        let songMeta = userStats.playHistory.find(h => h.id === id) || userStats.favorites.find(f => f.id === id);
        if (songMeta) mostPlayedSongs.push(songMeta);
    }

    if (mostPlayedSongs.length === 0) mostPlayedList.innerHTML = '<div style="color: #888; padding: 10px;">Play some songs to see them here.</div>';
    else mostPlayedSongs.forEach((s, i) => {
        const el = createSongCard(s, userStats.favorites.some(f => f.id === s.id));
        el.style.animationDelay = `${i * 0.05}s`;
        mostPlayedList.appendChild(el);
    });
};

window.toggleFavorite = function (videoId, iconEl) {
    let isFav = userStats.favorites.some(f => f.id === videoId);
    if (isFav) {
        userStats.favorites = userStats.favorites.filter(f => f.id !== videoId);
        iconEl.innerText = 'star_border';
        iconEl.style.color = '#888';
    } else {
        let songMeta = userStats.playHistory.find(h => h.id === videoId) || userStats.favorites.find(f => f.id === videoId);
        if (!songMeta && window.selectedSong && window.selectedSong.id === videoId) {
            songMeta = window.selectedSong;
        }
        if (songMeta) {
            userStats.favorites.push({
                id: videoId,
                title: songMeta.title,
                thumbnail: songMeta.thumbnail,
                duration: songMeta.duration
            });
            iconEl.innerText = 'star';
            iconEl.style.color = '#ffd700';
        }
    }
    window.gameAPI.saveUserStats(userStats);
    window.renderHomeStats();
    updateCachedSongsList();
};

window.uiLayer = uiLayer;

// YouTube IFrame API Ready Callback
let ytPlayer = null;
let isYtPlayerReady = false;

function onYouTubeIframeAPIReady() {
    console.log("YouTube API Ready");
    ytPlayer = new YT.Player('youtube-player', {
        playerVars: {
            'playsinline': 1,
            'controls': 0,
            'disablekb': 1,
            'fs': 0,
            'rel': 0,
            'modestbranding': 1,
            'showinfo': 0,
            'autoplay': 0,
            'mute': 1
        },
        events: {
            'onReady': (event) => {
                isYtPlayerReady = true;
                event.target.mute();
            }
        }
    });
}

window.gameAPI.onDownloadProgress((percent) => {
    progressBarFill.style.width = `${percent}%`;
    progressText.innerText = `Downloading Audio: ${percent.toFixed(1)}%`;
});

urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        startBtn.click();
    }
});

urlInput.addEventListener('input', () => {
    if (!urlInput.value.trim()) {
        searchResults.innerHTML = `
            <div id="empty-search-placeholder" style="display: flex; flex-direction: column; align-items: center; justify-content: center; height: 100%; opacity: 0.5; margin-top: 50px;">
                <span class="material-icons" style="font-size: 80px; margin-bottom: 20px;">search</span>
                <h2 style="font-size: 24px; margin: 0; font-weight: 500;">Search for a song</h2>
                <p style="font-size: 16px; margin-top: 10px;">Type a YouTube URL or search term above to begin</p>
            </div>
        `;
    }
});

window.selectedSong = null;
window.setDifficulty = function (diff, parentDiv = null, songId = null) {
    if (!songId && parentDiv) {
        songId = parentDiv.getAttribute('data-song-id');
    }

    if (songId) {
        setSongDifficulty(songId, diff);
        console.log(`[UI] Difficulty for song "${songId}" set to ${diff}`);

        // Update difficulty buttons ONLY on cards for this specific song ID
        const matchingDiffControls = document.querySelectorAll(`.inline-diff-control[data-song-id="${songId}"]`);
        matchingDiffControls.forEach(control => {
            Array.from(control.children).forEach(btn => {
                if (btn.innerText.trim().toLowerCase() === diff.toLowerCase()) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        });

        // Update highscore display ONLY for cards of this specific song ID
        updateCardHighScoreDisplay(songId);

        // If this song is currently selected in the player panel, sync sessionDifficulty and player UI
        if (window.selectedSong && window.selectedSong.id === songId) {
            sessionDifficulty = diff;
            if (typeof window.updateHighscoreDisplay === 'function') {
                window.updateHighscoreDisplay();
            }
            if (typeof updateQueueButtonVisibility === 'function') {
                updateQueueButtonVisibility();
            }
        }
    } else {
        sessionDifficulty = diff;
        console.log(`[UI] Global difficulty set to ${sessionDifficulty}`);
        if (parentDiv) {
            Array.from(parentDiv.children).forEach(btn => {
                if (btn.innerText.trim().toLowerCase() === diff.toLowerCase()) {
                    btn.classList.add('active');
                } else {
                    btn.classList.remove('active');
                }
            });
        }
    }
};

window.selectSong = function (id, title, thumbnail, duration, isCached = false, tempo = null) {
    const formattedDuration = formatDuration(duration);
    sessionDifficulty = getSongDifficulty(id);
    window.selectedSong = { id, title, thumbnail, duration: formattedDuration, isCached };

    // Save as last selected
    localStorage.setItem('ytHeroLastSong', JSON.stringify(window.selectedSong));

    const titleEl = document.getElementById('player-title');
    const artistEl = document.getElementById('player-artist');
    const durationEl = document.getElementById('player-duration');
    const tempoEl = document.getElementById('player-tempo');
    const playerPanel = document.getElementById('player-panel');

    titleEl.innerText = title;
    artistEl.innerText = isCached ? "Cached Locally" : "YouTube";
    durationEl.innerText = `Duration: ${formattedDuration}`;

    const updateTempoUI = (t) => {
        if (tempoEl) {
            if (t) {
                tempoEl.innerText = `Tempo: ${Math.round(t)} BPM`;
                tempoEl.style.display = 'block';
            } else {
                tempoEl.style.display = 'none';
            }
        }
    };

    if (isCached) {
        if (tempo) {
            updateTempoUI(tempo);
        } else {
            window.gameAPI.getCachedSongs().then(songs => {
                const matched = songs.find(s => s.id === id);
                if (matched && matched.tempo) {
                    updateTempoUI(matched.tempo);
                } else {
                    updateTempoUI(null);
                }
            });
        }
    } else {
        updateTempoUI(null);
    }

    window.updateHighscoreDisplay = function () {
        const highscoreEl = document.getElementById('player-highscore');
        if (highscoreEl) {
            let diff = sessionDifficulty || 'Medium';
            let hs = 0;
            if (userStats && userStats.highScores && userStats.highScores[window.selectedSong.id] && userStats.highScores[window.selectedSong.id][diff]) {
                hs = userStats.highScores[window.selectedSong.id][diff];
            }
            highscoreEl.innerText = `High Score (${diff}): ${formatHighScore(hs)}`;
            highscoreEl.style.display = 'block';
        }
    };
    window.updateHighscoreDisplay();

    // Add info entrance animation
    const infoEl = document.querySelector('.now-playing-info');
    if (infoEl) {
        infoEl.classList.remove('info-update');
        void infoEl.offsetWidth;
        infoEl.classList.add('info-update');
    }

    const thumbEl = document.getElementById('player-thumbnail');
    if (thumbEl) {
        thumbEl.src = thumbnail;
        thumbEl.style.display = 'block';
        thumbEl.classList.remove('player-thumb-enter');
        void thumbEl.offsetWidth;
        thumbEl.classList.add('player-thumb-enter');
    }

    // Mark player panel as having a song selected
    if (playerPanel) playerPanel.classList.add('song-selected');

    // Enable the play button with pulse animation
    const playBtn = document.getElementById('player-play-btn');
    playBtn.disabled = false;
    playBtn.style.opacity = '1';
    playBtn.classList.add('ready-pulse');

    if (typeof updateQueueButtonVisibility === 'function') {
        updateQueueButtonVisibility();
    }

    // Auto-open the player panel when a song is selected
    if (playerPanel && playerPanel.classList.contains('player-collapsed')) {
        openPlayerPanel();
    }

    // Update toggle button indicator
    const toggleBtn = document.getElementById('player-toggle-btn');
    if (toggleBtn) toggleBtn.classList.add('has-song');

    // Highlight selected search result
    document.querySelectorAll('.search-result').forEach(el => el.classList.remove('selected'));
    document.querySelectorAll('.search-result').forEach(el => {
        const titleDiv = el.querySelector('.search-result-title');
        if (titleDiv && titleDiv.innerText === title) {
            el.classList.add('selected');
        }
    });

    // Load YouTube video for preview context in background
    if (isYtPlayerReady && ytPlayer && ytPlayer.loadVideoById) {
        ytPlayer.loadVideoById(id);
    }
};

// Hook up the Right Panel Big Play Button
document.getElementById('player-play-btn').addEventListener('click', () => {
    if (window.selectedSong) {
        hideUILayer();
        initGame(window.selectedSong.id, window.selectedSong.title, window.selectedSong.thumbnail, window.selectedSong.duration, false); // Do not force regenerate on normal play
    }
});

document.getElementById('player-queue-btn').addEventListener('click', async () => {
    if (window.selectedSong) {
        const videoId = window.selectedSong.id;
        const title = window.selectedSong.title;
        const thumbnail = window.selectedSong.thumbnail;
        const diff = getSongDifficulty(videoId);

        // Check if this difficulty is already cached
        const cachedSongs = await window.gameAPI.getCachedSongs();
        const cachedSong = cachedSongs.find(s => s.id === videoId);
        let forceRegenerate = false;

        if (cachedSong && cachedSong.cachedDifficulties && cachedSong.cachedDifficulties.includes(diff)) {
            // It is already cached. Prompt confirmation
            const confirmQueue = confirm(`The difficulty "${diff}" for "${title}" has already been generated. Do you want to generate it again?`);
            if (!confirmQueue) {
                return;
            }
            forceRegenerate = true;
        }

        addToQueue(videoId, title, thumbnail, forceRegenerate);
    }
});

// Restore last song from localStorage (panel stays collapsed by default)
(function restoreLastSong() {
    try {
        const saved = localStorage.getItem('ytHeroLastSong');
        if (saved) {
            const parsed = JSON.parse(saved);
            if (parsed && parsed.id) {
                window.selectedSong = parsed;
                // Pre-populate the player panel with last song info (stays hidden)
                document.getElementById('player-title').innerText = parsed.title || 'YOUTUBE HERO';
                document.getElementById('player-artist').innerText = parsed.isCached ? "Cached Locally" : "YouTube";
                document.getElementById('player-duration').innerText = parsed.duration ? `Duration: ${parsed.duration}` : '';

                const tempoEl = document.getElementById('player-tempo');
                if (tempoEl) tempoEl.style.display = 'none';

                if (parsed.isCached) {
                    window.gameAPI.getCachedSongs().then(songs => {
                        const matched = songs.find(s => s.id === parsed.id);
                        if (matched && matched.tempo && tempoEl) {
                            tempoEl.innerText = `Tempo: ${Math.round(matched.tempo)} BPM`;
                            tempoEl.style.display = 'block';
                        }
                    });
                }

                const thumbEl = document.getElementById('player-thumbnail');
                if (thumbEl && parsed.thumbnail) {
                    thumbEl.src = parsed.thumbnail;
                    thumbEl.style.display = 'block';
                }
                const playBtn = document.getElementById('player-play-btn');
                playBtn.disabled = false;
                playBtn.style.opacity = '1';
                playBtn.classList.add('ready-pulse');

                if (typeof updateQueueButtonVisibility === 'function') {
                    updateQueueButtonVisibility();
                }
                document.getElementById('player-panel').classList.add('song-selected');
                // Mark toggle button as having a song
                const toggleBtn = document.getElementById('player-toggle-btn');
                if (toggleBtn) toggleBtn.classList.add('has-song');
            }
        }
    } catch (e) { /* ignore parse errors */ }
})();

// ========== PLAYER PANEL TOGGLE ==========
function openPlayerPanel() {
    const panel = document.getElementById('player-panel');
    const toggleBtn = document.getElementById('player-toggle-btn');
    const toggleIcon = document.getElementById('player-toggle-icon');
    if (!panel) return;

    panel.classList.remove('player-collapsed');
    panel.classList.add('player-expanded');
    if (toggleBtn) toggleBtn.classList.add('panel-open');
    if (toggleIcon) toggleIcon.innerText = 'chevron_right';
}

function closePlayerPanel() {
    const panel = document.getElementById('player-panel');
    const toggleBtn = document.getElementById('player-toggle-btn');
    const toggleIcon = document.getElementById('player-toggle-icon');
    if (!panel) return;

    panel.classList.remove('player-expanded');
    panel.classList.add('player-collapsed');
    if (toggleBtn) toggleBtn.classList.remove('panel-open');
    if (toggleIcon) toggleIcon.innerText = 'queue_music';
}

// ========== QUEUE PANEL TOGGLE ==========
function openQueuePanel() {
    const panel = document.getElementById('queue-container');
    const toggleBtn = document.getElementById('queue-toggle-btn');
    const toggleIcon = document.getElementById('queue-toggle-icon');
    if (!panel) return;

    panel.classList.remove('queue-collapsed');
    panel.classList.add('queue-expanded');
    if (toggleBtn) toggleBtn.classList.add('panel-open');
    if (toggleIcon) toggleIcon.innerText = 'chevron_left';
}

function closeQueuePanel() {
    const panel = document.getElementById('queue-container');
    const toggleBtn = document.getElementById('queue-toggle-btn');
    const toggleIcon = document.getElementById('queue-toggle-icon');
    if (!panel) return;

    panel.classList.remove('queue-expanded');
    panel.classList.add('queue-collapsed');
    if (toggleBtn) toggleBtn.classList.remove('panel-open');
    if (toggleIcon) toggleIcon.innerText = 'queue_play_next';
}

function toggleQueuePanel() {
    const panel = document.getElementById('queue-container');
    if (!panel) return;

    if (panel.classList.contains('queue-collapsed')) {
        openQueuePanel();
    } else {
        closeQueuePanel();
    }
}

// Queue Toggle button event
const queueToggleBtn = document.getElementById('queue-toggle-btn');
if (queueToggleBtn) {
    queueToggleBtn.addEventListener('click', () => {
        toggleQueuePanel();
    });
}

function togglePlayerPanel() {
    const panel = document.getElementById('player-panel');
    if (!panel) return;

    if (panel.classList.contains('player-collapsed')) {
        openPlayerPanel();
    } else {
        closePlayerPanel();
    }
}

// Toggle button event
const playerToggleBtn = document.getElementById('player-toggle-btn');
if (playerToggleBtn) {
    playerToggleBtn.addEventListener('click', () => {
        togglePlayerPanel();
    });
}

// ========== ANIMATED TAB NAVIGATION ==========
const navHome = document.getElementById('nav-home');
const navLibrary = document.getElementById('nav-library');
const navSearch = document.getElementById('nav-search');
const searchResultsContainer = document.getElementById('search-results');
const cachedSongsContainer = document.getElementById('cached-songs-container');
const homeContainer = document.getElementById('home-container');
const mainPanelTitle = document.getElementById('main-panel-title');

let currentTab = 'home'; // Track which tab we're on

cachedSongsContainer.style.display = 'none';
searchResultsContainer.style.display = 'none';

// Helper: animate panel transition
function animateTabSwitch(outgoing, incoming, direction, newTitle) {
    const outClass = direction === 'left' ? 'panel-slide-out-left' : 'panel-slide-out-right';
    const inClass = direction === 'left' ? 'panel-slide-in-left' : 'panel-slide-in-right';

    // Animate title morph
    mainPanelTitle.classList.remove('title-change');
    void mainPanelTitle.offsetWidth;
    mainPanelTitle.innerText = newTitle;
    mainPanelTitle.classList.add('title-change');

    // Slide out the old content
    if (outgoing) {
        outgoing.classList.remove('panel-slide-in-left', 'panel-slide-in-right', 'panel-slide-out-left', 'panel-slide-out-right');
        outgoing.classList.add(outClass);
        setTimeout(() => {
            outgoing.style.display = 'none';
            outgoing.classList.remove(outClass);
        }, 350);
    }

    // Slide in the new content
    setTimeout(() => {
        incoming.style.display = (incoming.id === 'search-results' || incoming.id === 'cached-songs-container') ? 'flex' : 'block';
        incoming.classList.remove('panel-slide-in-left', 'panel-slide-in-right', 'panel-slide-out-left', 'panel-slide-out-right');
        incoming.classList.add(inClass);

        // Stagger-animate individual items
        const items = incoming.querySelectorAll('.search-result');
        items.forEach((item, i) => {
            item.classList.remove('stagger-in');
            void item.offsetWidth;
            item.style.animationDelay = `${i * 0.05}s`;
            item.classList.add('stagger-in');
        });
    }, 100);
}

// Nav ripple effect helper
function addNavRipple(navItem) {
    navItem.classList.remove('nav-ripple');
    void navItem.offsetWidth;
    navItem.classList.add('nav-ripple');
    setTimeout(() => navItem.classList.remove('nav-ripple'), 500);
}

function getOutgoingContainer() {
    if (currentTab === 'home') return homeContainer;
    if (currentTab === 'library') return cachedSongsContainer;
    if (currentTab === 'search') return searchResultsContainer;
    return null;
}

navHome.addEventListener('click', () => {
    if (currentTab === 'home') return;
    const direction = 'right';

    navHome.classList.add('active');
    navLibrary.classList.remove('active');
    if (navSearch) navSearch.classList.remove('active');
    addNavRipple(navHome);

    animateTabSwitch(getOutgoingContainer(), homeContainer, direction, "HOME");
    currentTab = 'home';
    if (searchBarWrapper) searchBarWrapper.classList.add('hidden');
});

navLibrary.addEventListener('click', () => {
    if (currentTab === 'library') return;
    const direction = 'left';

    navLibrary.classList.add('active');
    navHome.classList.remove('active');
    if (navSearch) navSearch.classList.remove('active');
    addNavRipple(navLibrary);

    animateTabSwitch(getOutgoingContainer(), cachedSongsContainer, direction, "LIBRARY");
    currentTab = 'library';
    if (searchBarWrapper) searchBarWrapper.classList.add('hidden');
});

// ========== SEARCH NAV BUTTON ==========
// Clicking Search in the bottom nav focuses the search input and switches to Home tab
if (navSearch) {
    navSearch.addEventListener('click', () => {
        addNavRipple(navSearch);

        // Remove active states from other tabs
        navHome.classList.remove('active');
        navLibrary.classList.remove('active');

        // Show search bar
        if (searchBarWrapper) searchBarWrapper.classList.remove('hidden');

        // Switch to search view if not already there
        if (currentTab !== 'search') {
            const direction = currentTab === 'home' ? 'left' : 'right';
            animateTabSwitch(getOutgoingContainer(), searchResultsContainer, direction, "SEARCH");
            currentTab = 'search';
        }

        // Focus the search input with a visual pulse
        const searchInput = document.getElementById('youtube-url-input');
        if (searchInput) {
            searchInput.focus();
            searchInput.select();
        }
        // Pulse the search bar briefly
        if (searchBarWrapper) {
            searchBarWrapper.style.transition = 'box-shadow 0.15s ease, border-color 0.15s ease';
            searchBarWrapper.style.borderColor = 'var(--primary-accent)';
            searchBarWrapper.style.boxShadow = '0 0 25px rgba(0, 229, 255, 0.5)';
            setTimeout(() => {
                searchBarWrapper.style.borderColor = '';
                searchBarWrapper.style.boxShadow = '';
                setTimeout(() => {
                    searchBarWrapper.style.transition = '';
                }, 400);
            }, 800);
        }
    });
}

startBtn.addEventListener('click', async () => {
    const query = urlInput.value.trim();
    if (!query) return;

    // Check if it's a direct URL
    const videoId = extractVideoID(query);
    if (videoId) {
        hideUILayer();
        initGame(videoId, "Youtube Video", "");
        return;
    }

    // Otherwise, perform a search
    startBtn.innerHTML = '<span class="material-icons rotating">sync</span>';
    startBtn.disabled = true;

    try {
        const results = await window.gameAPI.searchYouTube(query);
        searchResults.innerHTML = '';

        if (results.length === 0) {
            searchResults.innerHTML = '<div style="text-align: center; margin-top: 50px; opacity: 0.7; font-size: 18px;">No results found</div>';
        } else {
            results.forEach((video, idx) => {
                const resultDiv = document.createElement('div');
                resultDiv.className = 'search-result stagger-in';
                resultDiv.style.animationDelay = `${idx * 0.06}s`;

                let escTitle = video.title.replace(/'/g, "\\'");
                resultDiv.innerHTML = `
                    <div class="search-result-content">
                        <img src="${video.thumbnail}" alt="thumbnail">
                        <div class="search-result-info">
                            <div class="search-result-title">${video.title}</div>
                            <div class="search-result-artist">Duration: ${video.duration}</div>
                            <div class="inline-diff-control" data-song-id="${video.id}">
                                <button class="diff-btn easy ${getSongDifficulty(video.id) === 'Easy' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDifficulty('Easy', this.parentElement, '${video.id}');">EASY</button>
                                <button class="diff-btn medium ${getSongDifficulty(video.id) === 'Medium' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDifficulty('Medium', this.parentElement, '${video.id}');">MEDIUM</button>
                                <button class="diff-btn hard ${getSongDifficulty(video.id) === 'Hard' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDifficulty('Hard', this.parentElement, '${video.id}');">HARD</button>
                                <button class="diff-btn insane ${getSongDifficulty(video.id) === 'Insane' ? 'active' : ''}" onclick="event.stopPropagation(); window.setDifficulty('Insane', this.parentElement, '${video.id}');">INSANE</button>
                            </div>
                        </div>
                    </div>
                `;
                resultDiv.onclick = () => window.selectSong(video.id, escTitle, video.thumbnail, video.duration, false);
                searchResults.appendChild(resultDiv);
            });
        }
    } catch (e) {
        console.error(e);
        searchResults.innerHTML = '<div>Error searching YouTube</div>';
    } finally {
        startBtn.innerHTML = '<span class="material-icons">search</span>';
        startBtn.disabled = false;
    }
});

function extractVideoID(url) {
    const regExp = /^.*(youtu.be\/|v\/|u\/\w\/|embed\/|watch\?v=|\&v=)([^#\&\?]*).*/;
    const match = url.match(regExp);
    return (match && match[2].length === 11) ? match[2] : null;
}

let currentVideoId = null;
let currentSongInfo = null;

// ============================================================================
// BeatGen Algorithm Engine — loaded from beatgen.js (window.BeatGen)
// Functions: loadBeatEngineParams, processAudioOffline, extractNotesFromChannel, assignLanes
// ============================================================================


// --- Queue System ---
let processingQueue = [];
let isProcessingQueue = false;
let currentRunningItem = null;

function updateQueueButtonVisibility() {
    const queueBtn = document.getElementById('player-queue-btn');
    if (!queueBtn) return;
    if (!window.selectedSong) {
        queueBtn.style.display = 'none';
        return;
    }

    const videoId = window.selectedSong.id;
    const diff = getSongDifficulty(videoId);

    // If it is already in the processingQueue for the current difficulty, hide the button
    const isAlreadyQueued = processingQueue.some(item => item.videoId === videoId && item.difficulty === diff);

    if (isAlreadyQueued) {
        queueBtn.style.display = 'none';
    } else {
        queueBtn.style.display = 'block';
        queueBtn.disabled = false;
        queueBtn.style.opacity = '1';
    }
}
window.updateQueueButtonVisibility = updateQueueButtonVisibility;

window.cancelQueuedSong = async function (index) {
    if (index < 0 || index >= processingQueue.length) return;

    const item = processingQueue[index];
    console.log(`[QUEUE] Cancelling song: "${item.title}" at ${item.difficulty} difficulty`);

    if (index === 0 && isProcessingQueue) {
        // Mark as cancelled so JS checks stop
        item.cancelled = true;

        const qText = document.getElementById('queue-progress-text');
        const qFill = document.getElementById('queue-progress-bar-fill');
        if (qText) qText.innerText = "Cancelling...";
        if (qFill) qFill.style.width = '0%';

        // Kill active child processes in the main process
        await window.gameAPI.cancelActiveDownloads();

        // Small delay to let OS release file locks
        await new Promise(r => setTimeout(r, 200));

        // Delete the matching difficulty map and files
        await window.gameAPI.deleteCachedSongDifficulty(item.videoId, item.difficulty);
    } else {
        // Just remove from queue if not processing yet
        processingQueue.splice(index, 1);
        updateQueueUI();
    }

    if (typeof updateCachedSongsList === 'function') {
        updateCachedSongsList();
    }
};

function updateQueueUI() {
    const queueContainer = document.getElementById('queue-container');
    const queueList = document.getElementById('queue-list');
    const queueProgressDisplay = document.getElementById('queue-progress-display');

    if (processingQueue.length === 0 && !isProcessingQueue) {
        if (queueProgressDisplay) queueProgressDisplay.style.display = 'none';
        queueList.innerHTML = '<div style="color: var(--text-secondary); text-align: center; margin-top: 40px; font-size: 14px;">No songs in queue</div>';
        if (typeof updateQueueButtonVisibility === 'function') updateQueueButtonVisibility();
        return;
    }

    // Auto-open when a song is first added
    if (processingQueue.length > 0 && queueContainer && queueContainer.classList.contains('queue-collapsed')) {
        openQueuePanel();
    }

    if (queueProgressDisplay) queueProgressDisplay.style.display = 'block';
    queueList.innerHTML = '';

    processingQueue.forEach((item, index) => {
        const div = document.createElement('div');
        div.className = 'queue-item';
        const queueNumber = index + 1;
        const isActive = index === 0 && isProcessingQueue;
        div.innerHTML = `
            <div class="queue-item-header">
                <span class="queue-item-title">
                    <span style="color: var(--lane-orange); margin-right: 6px; font-weight: 700;">#${queueNumber}</span>${item.title}
                </span>
            </div>
            <div class="queue-item-status">
                <span style="color: var(--text-secondary); font-weight: 600; text-transform: uppercase; font-size: 11px;">${item.difficulty || 'Medium'}</span>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span style="color: ${isActive ? 'var(--lane-orange)' : '#888'}; font-weight: 600;">
                        ${isActive ? 'Processing...' : 'Queued'}
                    </span>
                    <button class="cache-btn del-btn" style="padding: 2px 8px; font-size: 11px;" onclick="window.cancelQueuedSong(${index})">Cancel</button>
                </div>
            </div>
        `;
        queueList.appendChild(div);
    });

    if (typeof updateQueueButtonVisibility === 'function') updateQueueButtonVisibility();
}

async function addToQueue(videoId, title, thumbnail, forceRegenerate = false) {
    const diff = getSongDifficulty(videoId);
    if (processingQueue.find(item => item.videoId === videoId && item.difficulty === diff)) return; // Already queued for this difficulty
    processingQueue.push({ videoId, title, thumbnail, difficulty: diff, forceRegenerate });
    updateQueueUI();

    if (!isProcessingQueue) {
        processQueue();
    }
}

async function processQueue() {
    if (processingQueue.length === 0) {
        isProcessingQueue = false;
        updateQueueUI();
        return;
    }

    isProcessingQueue = true;
    updateQueueUI();
    const item = processingQueue[0];
    currentRunningItem = item;

    // Temporarily swap sessionDifficulty to the difficulty captured at enqueue time
    const savedDifficulty = sessionDifficulty;
    sessionDifficulty = item.difficulty || 'Medium';
    console.log(`[QUEUE] Processing #1: "${item.title}" at ${sessionDifficulty} difficulty`);

    try {
        await generateMapAndCache(item.videoId, item.title, item.thumbnail, 'background', item.forceRegenerate || false);
    } catch (err) {
        console.error("Background Process Error or Cancelled:", err);
    }

    // Restore the player's current difficulty selection
    sessionDifficulty = savedDifficulty;

    currentRunningItem = null;
    processingQueue.shift();
    processQueue();
}

function updateLoadingPhase(activePhaseNum, phaseStepPercent = 0, customSubtext = "", mode = 'foreground') {
    if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) {
        throw new Error("Cancelled");
    }

    const vocalSep = (typeof gameSettings !== 'undefined' && gameSettings) ? gameSettings.vocalSeparationEnabled : true;

    // Weight allocation across 5 phases:
    // Phase 1 (Download): 25%
    // Phase 2 (Stem Isolation): 25% (0% if disabled)
    // Phase 3 (AI Init): 10%
    // Phase 4 (Structure): 15%
    // Phase 5 (Charting): 25%
    let overallPercent = 0;
    if (activePhaseNum === 1) {
        overallPercent = Math.round((phaseStepPercent / 100) * 25);
    } else if (activePhaseNum === 2) {
        overallPercent = vocalSep ? 25 + Math.round((phaseStepPercent / 100) * 25) : 25;
    } else if (activePhaseNum === 3) {
        const base = vocalSep ? 50 : 25;
        overallPercent = base + Math.round((phaseStepPercent / 100) * 10);
    } else if (activePhaseNum === 4) {
        const base = vocalSep ? 60 : 35;
        overallPercent = base + Math.round((phaseStepPercent / 100) * 15);
    } else if (activePhaseNum === 5) {
        const base = vocalSep ? 75 : 50;
        const totalAvail = 100 - base;
        overallPercent = base + Math.round((phaseStepPercent / 100) * totalAvail);
    } else if (activePhaseNum > 5) {
        overallPercent = 100;
    }

    overallPercent = Math.min(100, Math.max(0, overallPercent));

    if (mode === 'foreground') {
        const overallPercentEl = document.getElementById('loading-overall-percent');
        if (overallPercentEl) overallPercentEl.innerText = `${overallPercent}%`;

        if (progressBarFill) progressBarFill.style.width = `${overallPercent}%`;
        if (progressText) progressText.innerText = customSubtext || "Processing track...";

        for (let i = 1; i <= 5; i++) {
            const item = document.querySelector(`.loading-phase-item[data-phase="${i}"]`);
            const iconEl = item ? item.querySelector('.phase-status-icon') : null;
            const subtextEl = document.getElementById(`phase-subtext-${i}`);

            if (!item || !iconEl || !subtextEl) continue;

            item.classList.remove('phase-pending', 'phase-active', 'phase-done');

            if (i === 2 && !vocalSep) {
                if (i < activePhaseNum) {
                    item.classList.add('phase-done');
                    iconEl.innerText = 'remove_circle_outline';
                    subtextEl.innerText = 'Skipped (Disabled in Settings)';
                } else if (i === activePhaseNum) {
                    item.classList.add('phase-done');
                    iconEl.innerText = 'remove_circle_outline';
                    subtextEl.innerText = 'Skipped';
                } else {
                    item.classList.add('phase-pending');
                    iconEl.innerText = 'radio_button_unchecked';
                    subtextEl.innerText = 'Skipped';
                }
                continue;
            }

            if (i < activePhaseNum) {
                item.classList.add('phase-done');
                iconEl.innerText = 'check_circle';
                if (subtextEl.innerText === 'Waiting...' || subtextEl.innerText.startsWith('Processing')) {
                    subtextEl.innerText = 'Complete';
                }
            } else if (i === activePhaseNum) {
                item.classList.add('phase-active');
                iconEl.innerText = 'sync';
                subtextEl.innerText = customSubtext || 'Processing...';
            } else {
                item.classList.add('phase-pending');
                iconEl.innerText = 'radio_button_unchecked';
                subtextEl.innerText = 'Waiting...';
            }
        }
    } else {
        const qText = document.getElementById('queue-progress-text');
        const qFill = document.getElementById('queue-progress-bar-fill');
        if (qText) qText.innerText = `P${activePhaseNum}/5 (${overallPercent}%): ${customSubtext}`;
        if (qFill) qFill.style.width = `${overallPercent}%`;
    }
}

async function generateMapAndCache(videoId, title, thumbnail, mode = 'foreground', forceRegenerate = false) {
    window.gameAPI.onDownloadProgress((percent) => {
        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) return;
        updateLoadingPhase(1, percent, `Downloading Audio: ${percent.toFixed(1)}%`, mode);
    });

    let savedMapObj = null;
    let savedTempo = null;
    if (!forceRegenerate) {
        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
        const savedData = await window.gameAPI.loadMapData(videoId, sessionDifficulty);
        if (savedData) {
            savedMapObj = savedData;
            savedTempo = Array.isArray(savedData) ? null : savedData.tempo;
        }
    }

    let finalMap = null;

    if (savedMapObj) {
        let rawNotes = [];
        if (Array.isArray(savedMapObj)) {
            rawNotes = savedMapObj;
        } else if (savedMapObj.notes) {
            rawNotes = savedMapObj.notes;
        } else if (savedMapObj.notesWithoutSustain) {
            rawNotes = savedMapObj.notesWithoutSustain;
        } else if (savedMapObj.notesWithSustain) {
            rawNotes = savedMapObj.notesWithSustain;
        }
        // Backward compatibility: strip length and sustain/hopo type properties
        finalMap = rawNotes.map(n => ({
            ...n,
            length: 0,
            type: 'note',
            isBeingHeld: false,
            isHOPO: false,
            sustainBroken: false
        }));
    }

    // Fast path: if we already have a cached map AND the audio file exists on disk,
    // skip all downloading / AI analysis / processing entirely.
    if (finalMap && finalMap.length > 0) {
        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
        const cachedAudioPath = `../data/audio/${videoId}.wav`;
        const audioExists = await window.gameAPI.checkFileExists(cachedAudioPath);
        if (audioExists) {
            if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
            const localAudioUrl = `file://${cachedAudioPath.replace(/^\.\./, '')}`;
            // Resolve the real audio URL via downloadAudio (returns instantly for cached files)
            const resolvedUrl = await window.gameAPI.downloadAudio(videoId);
            console.log(`[CACHE] Song "${videoId}" fully cached — skipping beatmap generation.`);

            for (let p = 1; p <= 5; p++) {
                updateLoadingPhase(p, 100, "Loaded from cache", mode);
            }
            return { localAudioUrl: resolvedUrl, finalMap, tempo: savedTempo };
        }
    }

    updateLoadingPhase(1, 0, "Starting Audio Download...", mode);

    if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
    console.log("[DEBUG] Calling window.gameAPI.downloadAudio() (full download)");
    const localAudioUrl = await window.gameAPI.downloadAudio(videoId);
    console.log("[DEBUG] window.gameAPI.downloadAudio() (full download) done.");
    updateLoadingPhase(1, 100, "Audio Stream Downloaded", mode);

    if (!finalMap || finalMap.length === 0) {
        let processingUrl = localAudioUrl;

        if (gameSettings.vocalSeparationEnabled) {
            if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
            updateLoadingPhase(2, 10, "Isolating Instrumentals (AI Stem Separation)...", mode);
            console.log("[DEBUG] Calling window.gameAPI.separateAudioStems()...");
            try {
                const sepResult = await window.gameAPI.separateAudioStems(videoId);
                if (sepResult && sepResult.success && sepResult.path) {
                    processingUrl = sepResult.path;
                    updateLoadingPhase(2, 100, "Vocal Separation Complete", mode);
                    console.log("[DEBUG] Vocal separation successful. Instrumental path:", processingUrl);
                } else {
                    updateLoadingPhase(2, 100, "Separation fallback to original audio", mode);
                    console.warn("[DEBUG] Vocal separation returned unsuccessful. Falling back to original audio.");
                }
            } catch (sepErr) {
                updateLoadingPhase(2, 100, "Separation fallback to original audio", mode);
                console.error("[DEBUG] Vocal separation failed:", sepErr, ". Falling back to original audio.");
            }
        } else {
            updateLoadingPhase(2, 100, "Skipped (Disabled in Settings)", mode);
        }

        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
        console.log(`[DEBUG] Fetching processingUrl via IPC:`, processingUrl);
        let uint8Array;
        try {
            uint8Array = await window.gameAPI.readFileBuffer(processingUrl);
        } catch (ipcErr) {
            console.error("[DEBUG] IPC readFileBuffer failed:", ipcErr);
            throw ipcErr;
        }
        if (!uint8Array) throw new Error("Failed to read file buffer via IPC");
        const arrayBuffer = uint8Array.buffer.slice(uint8Array.byteOffset, uint8Array.byteOffset + uint8Array.byteLength);
        console.log(`[DEBUG] IPC arrayBuffer byteLength:`, arrayBuffer.byteLength);

        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
        updateLoadingPhase(3, 20, "Loading AI Neural Parameters...", mode);
        console.log("[DEBUG] Calling window.BeatGen.loadBeatEngineParams()");
        await window.BeatGen.loadBeatEngineParams();
        updateLoadingPhase(3, 100, "AI Engine Parameters Loaded", mode);

        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
        updateLoadingPhase(4, 20, "Analyzing Song Structure & Tempo via AI...", mode);
        console.log("[DEBUG] Calling window.gameAPI.analyzeStructure()");
        let structureData = await window.gameAPI.analyzeStructure(videoId);
        console.log("[DEBUG] window.gameAPI.analyzeStructure() done.");
        let songTempo = structureData.tempo || 120;
        savedTempo = songTempo;
        updateLoadingPhase(4, 100, `Structure Analyzed (${Math.round(songTempo)} BPM)`, mode);

        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
        updateLoadingPhase(5, 5, "Analyzing Pitches & Charting Note Lanes...", mode);
        await new Promise(resolve => setTimeout(resolve, 50));

        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
        let cacheId = gameSettings.vocalSeparationEnabled ? videoId + "_instrumental" : videoId;
        console.log("[DEBUG] Calling window.BeatGen.processAudioOffline()...");
        let generatedMap;
        try {
            generatedMap = await window.BeatGen.processAudioOffline(arrayBuffer, songTempo, (percent) => {
                if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) {
                    throw new Error("Cancelled");
                }
                updateLoadingPhase(5, percent, `Charting Notes: ${Math.round(percent)}%`, mode);
            }, cacheId, sessionDifficulty);
        } catch (processErr) {
            console.error("[DEBUG] processAudioOffline failed:", processErr);
            throw processErr;
        }
        console.log("[DEBUG] window.BeatGen.processAudioOffline() done. Map length:", generatedMap ? generatedMap.length : 0);
        updateLoadingPhase(5, 100, "Chart Generation Complete!", mode);

        finalMap = generatedMap;

        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
        console.log("[DEBUG] Calling window.gameAPI.saveMapData()");
        await window.gameAPI.saveMapData(videoId, {
            difficulty: sessionDifficulty,
            tempo: songTempo,
            notes: finalMap
        });
    }

    if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) throw new Error("Cancelled");
    await window.gameAPI.saveCachedSong({ id: videoId, title: title, thumbnail: thumbnail });
    updateCachedSongsList();

    // Reset IPC
    window.gameAPI.onDownloadProgress((percent) => {
        if (mode === 'background' && currentRunningItem && currentRunningItem.cancelled) return;
        updateLoadingPhase(1, percent, `Downloading Audio: ${percent.toFixed(1)}%`, mode);
    });

    if (mode === 'background') {
        const qText = document.getElementById('queue-progress-text');
        const qFill = document.getElementById('queue-progress-bar-fill');
        if (qText) qText.innerText = 'Idle';
        if (qFill) qFill.style.width = '0%';
    }

    return { localAudioUrl, finalMap, tempo: savedTempo };
}

async function initGame(videoId, title, thumbnail, duration = "Unknown", forceRegenerate = false) {
    sessionDifficulty = getSongDifficulty(videoId);
    currentVideoId = videoId;
    currentSongInfo = { id: videoId, title: title, thumbnail: thumbnail, duration: duration };

    score = 0;
    combo = 0;
    multiplier = 1;
    updateHUD();
    hitEffects = [];
    hitParticles = [];
    activeRatingIndicator = null;
    lastUserInputTime = 0;

    // Set thumbnail as background
    document.getElementById('youtube-bg').style.backgroundImage = `url(${thumbnail})`;
    document.getElementById('youtube-bg').style.backgroundSize = 'cover';
    document.getElementById('youtube-bg').style.backgroundPosition = 'center';

    if (audioSourceBadge) { audioSourceBadge.textContent = '\uD83C\uDFB5 ORIGINAL'; }

    try {
        hideUILayer();
        progressContainer.style.display = 'flex';

        // Populate Track Header elements
        const thumbEl = document.getElementById('loading-thumb');
        if (thumbEl) thumbEl.src = thumbnail || '';
        const titleEl = document.getElementById('loading-title');
        if (titleEl) titleEl.innerText = title || 'Unknown Track';
        const diffBadgeEl = document.getElementById('loading-diff-badge');
        if (diffBadgeEl) diffBadgeEl.innerText = (sessionDifficulty || 'Medium').toUpperCase();

        updateLoadingPhase(1, 0, "Initializing Loading Sequence...", 'foreground');

        // Silence any leftover audio from a previous game immediately
        audioPlayer.pause();
        audioPlayer.src = '';
        if (audioCtx && audioCtx.state === 'running') {
            try {
                audioCtx.suspend();
            } catch (e) {
                console.warn("[AUDIO] Error suspending audioCtx before map generation:", e);
            }
        }

        if (isYtPlayerReady && ytPlayer && ytPlayer.loadVideoById) {
            ytPlayer.loadVideoById({ videoId: videoId, startSeconds: 0 });
            ytPlayer.pauseVideo();
        }

        const { localAudioUrl, finalMap, tempo } = await generateMapAndCache(videoId, title, thumbnail, 'foreground', forceRegenerate);
        songMap = finalMap;
        let finalAudioUrl = localAudioUrl;

        // Resolve original vs beatgen audio URLs for debug audio track switcher
        originalAudioUrl = localAudioUrl;
        const instAudioPath = `../data/audio/${videoId}_instrumental.wav`;
        const instExists = await window.gameAPI.checkFileExists(instAudioPath);
        if (instExists) {
            beatgenAudioUrl = originalAudioUrl.replace('.wav', '_instrumental.wav');
        } else {
            beatgenAudioUrl = localAudioUrl;
        }
        currentAudioTrack = 'original';

        progressContainer.style.display = 'none';
        document.getElementById('game-stats').style.display = 'block';
        document.getElementById('liquid-gradient-overlay').style.opacity = '1';

        // Setup real-time audio analyser (only once per AudioContext lifetime)
        if (!audioCtx) {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            analyser = audioCtx.createAnalyser();
            analyser.fftSize = 2048;
            source = audioCtx.createMediaElementSource(audioPlayer);
            source.connect(analyser);
            analyser.connect(audioCtx.destination);
            const bufferLength = analyser.frequencyBinCount;
            dataArray = new Uint8Array(bufferLength);
        }

        let gameLaunched = false;

        // launchGame is called once the audio is ready to play
        const launchGame = () => {
            if (gameLaunched) return; // prevent double-fire
            gameLaunched = true;
            audioPlayer.oncanplaythrough = null;
            console.log("[INIT] launchGame() fired! Starting gameplay.");
            if (audioCtx.state === 'suspended') audioCtx.resume();

            document.getElementById('song-progress-container').style.display = 'flex';
            const songTempoTextEl = document.getElementById('song-tempo-text');
            if (songTempoTextEl) {
                if (tempo) {
                    songTempoTextEl.innerText = `${Math.round(tempo)} BPM`;
                    songTempoTextEl.style.display = 'inline';
                } else {
                    songTempoTextEl.style.display = 'none';
                }
            }
            leadInActive = true;
            leadInStartTime = performance.now();
            audioPlayer.currentTime = 0;
            audioPlayer.pause();
            if (isYtPlayerReady && ytPlayer && ytPlayer.pauseVideo) {
                ytPlayer.pauseVideo();
            }

            gameActive = true;
            updateAudioTrackIndicator();
            isPaused = false;
            requestAnimationFrame(gameLoop);
        };

        // Assign src NOW (after all processing is done) and wait for canplaythrough
        console.log("[INIT] Setting audioPlayer.src =", finalAudioUrl);
        audioPlayer.oncanplaythrough = launchGame;
        audioPlayer.onloadedmetadata = () => {
            if (currentSongInfo && (!currentSongInfo.duration || currentSongInfo.duration === "Unknown")) {
                currentSongInfo.duration = formatDuration(audioPlayer.duration);
                console.log(`[INIT] Duration updated from metadata: ${currentSongInfo.duration}`);
                const durationEl = document.getElementById('player-duration');
                if (durationEl) durationEl.innerText = `Duration: ${currentSongInfo.duration}`;
            }
        };
        audioPlayer.src = finalAudioUrl;
        audioPlayer.load();

        // Fallback: if canplaythrough never fires (e.g. for large .wav files),
        // launch after a short delay once readyState is at least HAVE_CURRENT_DATA
        setTimeout(() => {
            if (!gameLaunched) {
                console.warn("[INIT] canplaythrough didn't fire in 3s. readyState:", audioPlayer.readyState, "Forcing launch...");
                launchGame();
            }
        }, 3000);

        audioPlayer.onended = () => {
            endGame(true);
        }

    } catch (err) {
        // Detailed error to console for developers
        console.error("CRITICAL GAME ERROR:", err);

        // generic user-friendly message in the UI instead of a stack trace
        progressText.innerText = "Fatal Error: Check console for details.";
        progressContainer.style.display = 'flex';
        showUILayer();
        startBtn.innerHTML = '<span class="material-icons">error</span>';
    }
}

function endGame(completed = false) {
    if (completed && currentSongInfo && userStats) {
        const videoId = currentSongInfo.id;
        const diff = sessionDifficulty || 'Medium';

        userStats.playHistory.unshift({
            id: videoId,
            title: currentSongInfo.title,
            thumbnail: currentSongInfo.thumbnail,
            duration: (currentSongInfo.duration && currentSongInfo.duration !== "Unknown") ? currentSongInfo.duration : formatDuration(audioPlayer.duration),
            timestamp: Date.now()
        });
        if (userStats.playHistory.length > 50) userStats.playHistory.pop();

        userStats.playCounts[videoId] = (userStats.playCounts[videoId] || 0) + 1;

        const previousHighScore = (userStats.highScores[videoId] && userStats.highScores[videoId][diff]) || 0;
        const roundedScore = Math.floor(score);
        const isNewHighScore = roundedScore > previousHighScore;

        if (!userStats.highScores[videoId]) userStats.highScores[videoId] = {};
        if (isNewHighScore) {
            userStats.highScores[videoId][diff] = roundedScore;
        }

        window.gameAPI.saveUserStats(userStats);
        if (typeof window.renderHomeStats === 'function') window.renderHomeStats();

        // Calculate statistics
        const totalNotes = songMap.length;
        const notesHit = songMap.filter(n => n.hit).length;
        const notesMissed = songMap.filter(n => !n.hit).length;
        const accuracy = totalNotes > 0 ? ((notesHit / totalNotes) * 100).toFixed(2) : "100.00";

        // Populate stats screen
        document.getElementById('stats-song-title').innerText = currentSongInfo.title;
        document.getElementById('stats-song-difficulty').innerText = diff;
        document.getElementById('stats-score-val').innerText = formatHighScore(Math.floor(score));
        document.getElementById('stats-accuracy-val').innerText = `${accuracy}%`;
        document.getElementById('stats-hit-val').innerText = notesHit;
        document.getElementById('stats-miss-val').innerText = notesMissed;
        document.getElementById('stats-total-val').innerText = totalNotes;

        const highscoreBanner = document.getElementById('stats-highscore-banner');
        if (isNewHighScore) {
            highscoreBanner.style.display = 'block';
        } else {
            highscoreBanner.style.display = 'none';
        }

        // Show stats screen
        document.getElementById('stats-screen').style.display = 'flex';

        // Pause and reset game loop but don't exit to menu yet
        gameActive = false;
        audioPlayer.pause();
        if (isYtPlayerReady && ytPlayer && ytPlayer.pauseVideo) {
            ytPlayer.pauseVideo();
            ytPlayer.seekTo(0);
        }
        document.getElementById('game-stats').style.display = 'none';
        document.getElementById('song-progress-container').style.display = 'none';
        pauseMenu.style.display = 'none';
        document.getElementById('liquid-gradient-overlay').style.opacity = '0';
        return;
    }

    // Early exit or after continue
    closeGameAndReturnToMenu();
}

function closeGameAndReturnToMenu() {
    gameActive = false;
    currentSongMapVariants = null;
    audioPlayer.pause();
    if (isYtPlayerReady && ytPlayer && ytPlayer.pauseVideo) {
        ytPlayer.pauseVideo();
        ytPlayer.seekTo(0);
    }
    document.getElementById('game-stats').style.display = 'none';
    document.getElementById('song-progress-container').style.display = 'none';
    pauseMenu.style.display = 'none';
    document.getElementById('stats-screen').style.display = 'none';
    document.getElementById('liquid-gradient-overlay').style.opacity = '0';

    // Smooth re-entrance: re-trigger the menu fade-in animation
    showUILayer();

    // Re-animate the player panel 
    const playerPanel = document.getElementById('player-panel');
    if (playerPanel) {
        playerPanel.classList.add('panel-fade-in');
        setTimeout(() => playerPanel.classList.remove('panel-fade-in'), 500);
    }

    hitEffects = [];
    hitParticles = [];
    hitShockwaves = [];
    activeRatingIndicator = null;
    lastUserInputTime = 0;
    activeKeys = { 0: false, 1: false, 2: false, 3: false, 4: false };
    hasHitForCurrentPress = { 0: false, 1: false, 2: false, 3: false, 4: false };
    ctx.clearRect(0, 0, cw, ch);
}

function formatTime(seconds) {
    if (isNaN(seconds)) return "0:00";
    const m = Math.floor(seconds / 60);
    const s = Math.floor(seconds % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
}

function updateHUD() {
    const scoreValEl = document.getElementById('score-value');
    if (scoreValEl) {
        const roundedScore = Math.floor(score);
        scoreValEl.innerText = roundedScore;
        if (roundedScore >= 10000000) {
            scoreValEl.style.fontSize = 'clamp(22px, 1.8vw, 32px)';
        } else if (roundedScore >= 1000000) {
            scoreValEl.style.fontSize = 'clamp(26px, 2.1vw, 36px)';
        } else {
            scoreValEl.style.fontSize = '';
        }
    }
    document.getElementById('multiplier').innerText = `${multiplier}x`;
    document.getElementById('combo-value').innerText = combo;

    // Trigger multiplier scale up bump animation on wrapper
    const multVal = multiplier;
    const multEl = document.getElementById('multiplier-wrapper');
    if (multEl && multVal !== lastMultiplier) {
        if (multVal > lastMultiplier) {
            multEl.classList.remove('mult-bump');
            void multEl.offsetWidth; // trigger reflow
            multEl.classList.add('mult-bump');
        }
        lastMultiplier = multVal;
    }

    // Update Song Progress
    if (audioPlayer && audioPlayer.duration) {
        let current = getGameTime();
        if (current < 0) current = 0;
        const total = audioPlayer.duration;
        const percent = (current / total) * 100;

        document.getElementById('song-time-text').innerText = `${formatTime(current)} / ${formatTime(total)}`;
        document.getElementById('song-progress-fill').style.width = `${percent}%`;

    }
}

function getPerspectiveVars() {
    const horizonY = ch * horizonYRatio;
    const hitZoneY = ch * 0.87; // Scale with resolution (was: ch - 100)
    const horizonWidth = cw * horizonWidthRatio;
    const hitWidth = cw * hitWidthRatio;
    // Width at the hit zone Y (interpolated along the trapezoid from horizon to bottom)
    const tHit = (hitZoneY - horizonY) / (ch - horizonY);
    const hitZoneWidth = horizonWidth + (hitWidth - horizonWidth) * tHit;
    return { horizonY, hitZoneY, horizonWidth, hitWidth, hitZoneWidth };
}

function drawHighway() {
    ctx.clearRect(0, 0, cw, ch);

    const { horizonY, hitZoneY, horizonWidth, hitWidth, hitZoneWidth } = getPerspectiveVars();

    // Draw Audio-Reactive Ambient Backdrop Bloom (always visible, morphing colors/radius with beat)
    // Tone down brightness for eye comfort and increase dynamic range/reactivity
    const baseline = 0.18;
    let reaction = 0;
    if (beatVolume > baseline) {
        reaction = Math.min(1.0, (beatVolume - baseline) / (0.75 - baseline));
    }
    // Apply power curve to make beat peaks pop significantly
    const intensity = Math.pow(reaction, 1.6);

    // Inner color: morphs from Neon Cyan/Blue to Hot Magenta
    const innerR = Math.floor(intensity * 255);
    const innerG = Math.floor((1 - intensity) * 160);
    const innerB = 255;
    const innerA = 0.05 + intensity * 0.15; // Toned down from 0.16 -> 0.50 range to 0.05 -> 0.20 range

    // Middle color: morphs from Deep Violet to electric Turquoise
    const midR = Math.floor((1 - intensity) * 80);
    const midG = Math.floor(intensity * 240);
    const midB = Math.floor((1 - intensity) * 180 + intensity * 255);
    const midA = 0.02 + intensity * 0.08; // Toned down from 0.08 -> 0.30 range to 0.02 -> 0.10 range

    const maxRadius = Math.max(cw, ch) * (0.35 + intensity * 0.35);
    const grad = ctx.createRadialGradient(cw / 2, horizonY, 2, cw / 2, horizonY, maxRadius);
    grad.addColorStop(0, `rgba(${innerR}, ${innerG}, ${innerB}, ${innerA})`);
    grad.addColorStop(0.4, `rgba(${midR}, ${midG}, ${midB}, ${midA})`);
    grad.addColorStop(1, 'rgba(0, 0, 0, 0)');

    ctx.save();
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, cw, ch);
    ctx.restore();

    // Debug Waveform Overlay (Drawn BEFORE Highway)
    if (gameSettings.debugWaveform && analyser && dataArray) {
        analyser.getByteTimeDomainData(dataArray);

        ctx.lineWidth = 2;
        ctx.strokeStyle = 'rgba(0, 255, 0, 0.4)';
        ctx.beginPath();

        const sliceWidth = cw / dataArray.length;
        let x = 0;

        // Target draw area: between horizon and hitZone
        const yOffset = horizonY;
        const waveHeight = (hitZoneY - horizonY) * 0.8;

        for (let i = 0; i < dataArray.length; i++) {
            const v = dataArray[i] / 128.0; // 0.0 to 2.0
            const y = yOffset + (v * waveHeight / 2);

            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);

            x += sliceWidth;
        }
        ctx.stroke();
    }

    // Draw Highway Trapezoid
    ctx.fillStyle = 'rgba(10, 10, 15, 0.4)';
    ctx.beginPath();
    ctx.moveTo(cw / 2 - horizonWidth / 2, horizonY);
    ctx.lineTo(cw / 2 + horizonWidth / 2, horizonY);
    ctx.lineTo(cw / 2 + hitWidth / 2, ch);
    ctx.lineTo(cw / 2 - hitWidth / 2, ch);
    ctx.fill();

    // Highway Borders (Audio Reactive)
    ctx.strokeStyle = `rgba(0, 229, 255, ${0.6 + beatVolume * 0.4})`;
    ctx.lineWidth = 4 + beatVolume * 8;
    ctx.shadowBlur = 15 + beatVolume * 25;
    ctx.shadowColor = `rgba(0, 229, 255, ${0.7 + beatVolume * 0.3})`;
    ctx.beginPath();
    ctx.moveTo(cw / 2 - horizonWidth / 2, horizonY);
    ctx.lineTo(cw / 2 - hitWidth / 2, ch);
    ctx.moveTo(cw / 2 + horizonWidth / 2, horizonY);
    ctx.lineTo(cw / 2 + hitWidth / 2, ch);
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Draw Lane Separators
    ctx.strokeStyle = `rgba(255, 255, 255, ${0.1 + beatVolume * 0.15})`;
    ctx.lineWidth = 2;
    for (let i = 1; i < lanes; i++) {
        const horizonX = cw / 2 - horizonWidth / 2 + (horizonWidth / lanes) * i;
        const hitX = cw / 2 - hitWidth / 2 + (hitWidth / lanes) * i;
        ctx.beginPath();
        ctx.moveTo(horizonX, horizonY);
        ctx.lineTo(hitX, ch);
        ctx.stroke();
    }

    // Draw Hitbox timing window band on the highway (Debug Option)
    if (gameSettings.debugHitboxes) {
        const hitWinSec = (gameSettings.hitWindow || 150) / 1000.0;
        const pEarly = 1 - (hitWinSec / viewDuration);
        const pLate = 1 - (-hitWinSec / viewDuration);

        const yEarly = horizonY + (hitZoneY - horizonY) * pEarly;
        const yLate = horizonY + (hitZoneY - horizonY) * pLate;

        const tEarly = (yEarly - horizonY) / (ch - horizonY);
        const wEarly = horizonWidth + (hitWidth - horizonWidth) * tEarly;

        const tLate = (yLate - horizonY) / (ch - horizonY);
        const wLate = horizonWidth + (hitWidth - horizonWidth) * tLate;

        ctx.save();
        ctx.fillStyle = 'rgba(0, 229, 255, 0.12)';
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([4, 4]);

        ctx.beginPath();
        ctx.moveTo(cw / 2 - wEarly / 2, yEarly);
        ctx.lineTo(cw / 2 + wEarly / 2, yEarly);
        ctx.lineTo(cw / 2 + wLate / 2, yLate);
        ctx.lineTo(cw / 2 - wLate / 2, yLate);
        ctx.closePath();
        ctx.fill();
        ctx.stroke();
        ctx.restore();
    }

    // Draw Lane Flashes (if key is pressed)
    for (let i = 0; i < lanes; i++) {
        if (activeKeys[i] && gameSettings.laneFlashesEnabled) {
            ctx.save();
            const horizonX = cw / 2 - horizonWidth / 2 + (horizonWidth / lanes) * i;
            const nextHorizonX = cw / 2 - horizonWidth / 2 + (horizonWidth / lanes) * (i + 1);
            const hitX = cw / 2 - hitWidth / 2 + (hitWidth / lanes) * i;
            const nextHitX = cw / 2 - hitWidth / 2 + (hitWidth / lanes) * (i + 1);
            const laneCenterX = (hitX + nextHitX) / 2;

            const flashGrad = ctx.createLinearGradient(laneCenterX, hitZoneY, laneCenterX, horizonY);
            flashGrad.addColorStop(0, `${laneColors[i]}3b`); // light opacity at hit zone
            flashGrad.addColorStop(1, `${laneColors[i]}00`); // fades completely at horizon
            ctx.fillStyle = flashGrad;

            ctx.beginPath();
            ctx.moveTo(horizonX, horizonY);
            ctx.lineTo(nextHorizonX, horizonY);
            ctx.lineTo(nextHitX, ch);
            ctx.lineTo(hitX, ch);
            ctx.closePath();
            ctx.fill();
            ctx.restore();
        }
    }

    // Draw Hit Zone (Perspective Strike Line)
    ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
    ctx.shadowBlur = 15 + beatVolume * 25;
    ctx.shadowColor = '#00e5ff';
    ctx.beginPath();
    ctx.moveTo(cw / 2 - hitZoneWidth / 2, hitZoneY - 3);
    ctx.lineTo(cw / 2 + hitZoneWidth / 2, hitZoneY - 3);
    ctx.lineTo(cw / 2 + (hitZoneWidth + 10) / 2, hitZoneY + 3);
    ctx.lineTo(cw / 2 - (hitZoneWidth + 10) / 2, hitZoneY + 3);
    ctx.fill();
    ctx.shadowBlur = 0;

    // Draw Hit Keys Receptacles
    const keys = ['A', 'S', 'J', 'K', 'L'];
    ctx.font = "600 16px 'Inter', sans-serif";
    ctx.textAlign = 'center';

    for (let i = 0; i < lanes; i++) {
        const laneW = hitZoneWidth / lanes;
        const laneCenterX = cw / 2 - hitZoneWidth / 2 + laneW * i + laneW / 2;

        // Base color
        ctx.fillStyle = activeKeys[i] ? laneColors[i] : 'rgba(0,0,0,0.5)';
        ctx.strokeStyle = laneColors[i];
        ctx.lineWidth = activeKeys[i] ? (5 + beatVolume * 3) : 3;

        ctx.beginPath();
        // Ellipse to simulate 3D angle
        ctx.ellipse(laneCenterX, hitZoneY, laneW / 3, laneW / 6, 0, 0, Math.PI * 2);
        if (activeKeys[i]) {
            ctx.shadowBlur = 20 + beatVolume * 15;
            ctx.shadowColor = laneColors[i];
        }
        ctx.fill();
        ctx.stroke();
        ctx.shadowBlur = 0;

        ctx.fillStyle = 'white';
        // Simple text indicator below (hidden by default request)
        // ctx.fillText(keys[i], laneCenterX, hitZoneY + 30);
    }
}

function updateNotes() {
    const { horizonY, hitZoneY, horizonWidth, hitWidth, hitZoneWidth } = getPerspectiveVars();
    const currentTime = getGameTime();

    for (let i = 0; i < songMap.length; i++) {
        let note = songMap[i];

        if (note.hit || note.missed) continue;

        const timeUntilHit = note.time - currentTime;

        // Skip notes too far in the future
        if (timeUntilHit > viewDuration) continue;

        // Ghost Autoplay
        if (gameSettings.debugAutoplay && timeUntilHit <= 0.05 && timeUntilHit > -missWindow) {
            note.hit = true;
            playHitSound();
            score += 50 * multiplier;
            combo++;
            if (combo % 10 === 0 && multiplier < 4) multiplier++;
            setRatingIndicator("PERFECT", '#00ffff');

            // Spawn Neon Particles & Shockwave
            const laneW = hitZoneWidth / lanes;
            const fxX = cw / 2 - hitZoneWidth / 2 + (note.lane * laneW) + (laneW / 2);
            for (let j = 0; j < 15; j++) {
                hitParticles.push({
                    x: fxX + (Math.random() - 0.5) * 20,
                    y: hitZoneY,
                    vx: (Math.random() - 0.5) * 6,
                    vy: -Math.random() * 8,
                    life: 1.0,
                    color: Math.random() > 0.3 ? laneColors[note.lane] : '#ffffff',
                    size: Math.random() * 6 + 3
                });
            }
            hitShockwaves.push({
                x: fxX,
                y: hitZoneY,
                radius: 10,
                maxRadius: laneW * 0.9,
                color: laneColors[note.lane],
                alpha: 1.0,
                lineWidth: 4
            });

            updateHUD();

            // Visual feedback on the lane key
            activeKeys[note.lane] = true;
            setTimeout(() => { activeKeys[note.lane] = false; }, 100);
            continue;
        }

        // Check if key is held down and note is passing by (within hit window)
        const hitWindow = (gameSettings.hitWindow || 150) / 1000.0;
        if (activeKeys[note.lane] && !hasHitForCurrentPress[note.lane]) {
            const timeDiff = Math.abs(timeUntilHit);
            if (timeDiff <= hitWindow) {
                registerHit(note, currentTime);
                continue;
            }
        }

        // Note missed
        if (timeUntilHit < -missWindow) {
            note.missed = true;
            combo = 0;
            multiplier = 1;
            shakeAmount = 7; // Trigger screen shake
            setRatingIndicator("MISS", '#ff0000');
            updateHUD();
            continue;
        }

        // Calculate progress (0 = horizon, 1 = hitZone)
        const p = 1 - (timeUntilHit / viewDuration);

        // Let it fall slightly past the hit zone
        const y = horizonY + (hitZoneY - horizonY) * p;

        // Calculate X position using the actual trapezoid interpolation
        // The lane lines run from (horizonX, horizonY) to (bottomX, ch),
        // so at any Y the width is: lerp(horizonWidth, hitWidth, (y - horizonY) / (ch - horizonY))
        const t = (y - horizonY) / (ch - horizonY);
        const wAtY = horizonWidth + (hitWidth - horizonWidth) * t;
        const laneW = wAtY / lanes;
        const x = cw / 2 - wAtY / 2 + (note.lane * laneW) + (laneW / 2);

        // Scale note size based on perspective
        const scale = 0.3 + (p * 0.7);
        const radius = (laneW / 3) * scale;

        if (note.rejected) {
            if (gameSettings.debugRejected) {
                drawGem(x, y, radius, note.lane, true, note);
            }
            continue;
        }

        drawGem(x, y, radius, note.lane, false, note);
    }
}

function drawGem(x, y, rx, laneIdx, rejected = false, note = null) {
    const ry = rx * 0.5; // Flattened ellipse to look like 3D gem

    if (gameSettings.debugHitboxes && note) {
        const hitWinSec = (gameSettings.hitWindow || 150) / 1000.0;
        const timeUntilHit = note.time - getGameTime();
        const isInWindow = Math.abs(timeUntilHit) <= hitWinSec;

        ctx.save();
        ctx.strokeStyle = isInWindow ? '#00ff00' : '#ff3333';
        ctx.lineWidth = 1.5;
        ctx.setLineDash([3, 3]);
        ctx.shadowBlur = isInWindow ? 5 : 0;
        ctx.shadowColor = isInWindow ? '#00ff00' : 'transparent';
        ctx.strokeRect(x - rx - 4, y - ry - 4, rx * 2 + 8, ry * 2 + 8);
        ctx.restore();
    }

    if (gameSettings.debugNoteTimestamps && note) {
        ctx.save();
        ctx.fillStyle = '#ffffff';
        ctx.font = "bold 11px 'Inter', sans-serif";
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.shadowBlur = 3;
        ctx.shadowColor = '#000000';
        ctx.fillText(`${note.time.toFixed(3)}s`, x + rx + 6, y);
        ctx.restore();
    }

    if (rejected) {
        ctx.fillStyle = 'rgba(180, 180, 180, 0.5)'; // semi-transparent gray gem
        ctx.beginPath();
        ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = 'rgba(255, 80, 80, 0.6)'; // red outline so it pops against highway
        ctx.lineWidth = 2;
        ctx.stroke();

        // Draw small "X" in center
        ctx.strokeStyle = 'rgba(255, 50, 50, 0.7)';
        ctx.lineWidth = 1.5;
        const s = rx * 0.3;
        ctx.beginPath();
        ctx.moveTo(x - s, y - s); ctx.lineTo(x + s, y + s);
        ctx.moveTo(x + s, y - s); ctx.lineTo(x - s, y + s);
        ctx.stroke();
        return;
    }

    // Outer glow
    ctx.shadowBlur = 20 * (rx / 20);
    ctx.shadowColor = laneColors[laneIdx];

    ctx.fillStyle = '#fff'; // center bright
    ctx.beginPath();
    ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.shadowBlur = 0;

    // Colored body overlay
    ctx.fillStyle = laneColors[laneIdx];
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.ellipse(x, y, rx * 0.9, ry * 0.9, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1.0;

    // Stroke
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.8)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
}

function gameLoop() {
    if (!gameActive) return;

    if (isPaused) {
        requestAnimationFrame(gameLoop);
        return;
    }

    const nowFrame = performance.now();
    const deltaFrame = nowFrame - lastFrameTime;
    lastFrameTime = nowFrame;

    frameCount++;
    if (nowFrame - lastFpsUpdateTime >= 1000) {
        currentFps = Math.round((frameCount * 1000) / (nowFrame - lastFpsUpdateTime));
        frameCount = 0;
        lastFpsUpdateTime = nowFrame;
    }
    currentFrameTimeMs = deltaFrame;

    // Update real-time audio analysis beatVolume
    beatVolume = 0;
    if (analyser && dataArray) {
        analyser.getByteFrequencyData(dataArray);
        let bassSum = 0;
        const bassRange = Math.min(15, dataArray.length);
        for (let i = 0; i < bassRange; i++) {
            bassSum += dataArray[i];
        }
        beatVolume = bassSum / bassRange / 255.0; // 0 to 1
    }

    if (isYtPlayerReady && ytPlayer && ytPlayer.seekTo) {
        let ytTime = ytPlayer.getCurrentTime();
        let gameTime = getGameTime();

        if (Math.abs(ytTime - gameTime) > 0.5) {
            ytPlayer.seekTo(gameTime, true);
        }
    }

    // Screen shake
    if (shakeAmount > 0) {
        const dx = (Math.random() - 0.5) * shakeAmount;
        const dy = (Math.random() - 0.5) * shakeAmount;
        ctx.save();
        ctx.translate(dx, dy);
    }

    drawHighway();
    updateNotes();
    updateHUD(); // Constantly update the progress bar

    // Draw hit shockwaves
    for (let i = hitShockwaves.length - 1; i >= 0; i--) {
        let sw = hitShockwaves[i];
        ctx.save();
        ctx.strokeStyle = sw.color;
        ctx.globalAlpha = sw.alpha;
        ctx.lineWidth = sw.lineWidth;
        ctx.shadowBlur = 15;
        ctx.shadowColor = sw.color;

        ctx.beginPath();
        ctx.ellipse(sw.x, sw.y, sw.radius, sw.radius * 0.4, 0, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();

        sw.radius += (sw.maxRadius - 10) * 0.12;
        sw.alpha -= 0.07;
        sw.lineWidth *= 0.94;

        if (sw.alpha <= 0) {
            hitShockwaves.splice(i, 1);
        }
    }

    // Draw hit text effects
    for (let i = hitEffects.length - 1; i >= 0; i--) {
        let fx = hitEffects[i];
        ctx.fillStyle = fx.color;
        ctx.globalAlpha = fx.alpha;

        ctx.font = "900 38px 'Outfit', sans-serif";
        ctx.textAlign = "center";

        ctx.shadowBlur = 20;
        ctx.shadowColor = fx.color;

        // Add a slight scale-up effect using alpha
        ctx.save();
        ctx.translate(fx.x, fx.y);
        ctx.fillText(fx.text, 0, 0);
        ctx.restore();

        // Reset shadow and alpha
        ctx.shadowBlur = 0;
        ctx.globalAlpha = 1.0;

        fx.y -= 0; // stop moving upwards
        fx.alpha -= 0.1; // fast fade out

        if (fx.alpha <= 0) {
            hitEffects.splice(i, 1);
        }
    }

    // Draw active rating indicator (persistent, only updates on hit/miss/dropped, fades after 1.5s of no user input)
    if (activeRatingIndicator) {
        const timeSinceInput = performance.now() - lastUserInputTime;
        if (timeSinceInput > 1500) {
            const fadeProgress = (timeSinceInput - 1500) / 500; // fade over 500ms
            activeRatingIndicator.alpha = Math.max(0, 1 - fadeProgress);
        } else {
            activeRatingIndicator.alpha = 1.0;
        }

        if (activeRatingIndicator.alpha > 0) {
            ctx.fillStyle = activeRatingIndicator.color;
            ctx.globalAlpha = activeRatingIndicator.alpha;

            ctx.font = "900 38px 'Outfit', sans-serif";
            ctx.textAlign = "center";

            ctx.shadowBlur = 20;
            ctx.shadowColor = activeRatingIndicator.color;

            // Recalculate x in case canvas resized
            activeRatingIndicator.x = cw / 2;

            ctx.save();
            ctx.translate(activeRatingIndicator.x, activeRatingIndicator.y);
            ctx.fillText(activeRatingIndicator.text, 0, 0);
            ctx.restore();

            // Reset shadow and alpha
            ctx.shadowBlur = 0;
            ctx.globalAlpha = 1.0;
        }
    }

    // Draw fire particles for hits
    for (let i = hitParticles.length - 1; i >= 0; i--) {
        let p = hitParticles[i];
        ctx.save();
        ctx.shadowBlur = 8;
        ctx.shadowColor = p.color;
        ctx.fillStyle = p.color;
        ctx.globalAlpha = p.life;
        ctx.beginPath();
        ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        p.x += p.vx;
        p.y += p.vy;
        p.vy += 0.2; // slight gravity
        p.life -= 0.05;

        if (p.life <= 0) hitParticles.splice(i, 1);
    }

    // Clean up old hit visualizer data
    const now = performance.now();
    hitHistory = hitHistory.filter(h => now - h.timestamp < 3000); // keep for 3s

    // Draw Hit Window Visualizer (Debug Option)
    if (gameSettings.debugVisualizer) {
        const vW = cw * 0.4;
        const vH = 40;
        const vX = cw / 2 - vW / 2;
        const vY = ch - vH - 20;

        ctx.fillStyle = 'rgba(0,0,0,0.7)';
        ctx.fillRect(vX, vY, vW, vH);

        // Center Perfect Line
        ctx.strokeStyle = '#00ffff';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(vX + vW / 2, vY);
        ctx.lineTo(vX + vW / 2, vY + vH);
        ctx.stroke();

        // Late (Right) / Early (Left) margins
        ctx.fillStyle = '#888';
        ctx.font = "500 12px 'Inter', sans-serif";
        ctx.textAlign = 'left';
        ctx.fillText("EARLY", vX + 5, vY + vH - 5);
        ctx.textAlign = 'right';
        ctx.fillText("LATE", vX + vW - 5, vY + vH - 5);

        // Max visual bound is Miss window (e.g. 150ms)
        const maxBoundMs = 150;
        for (const hit of hitHistory) {
            // map diffMs (-150 to 150) to X pixel (-vW/2 to +vW/2)
            const mapX = (hit.diffMs / maxBoundMs) * (vW / 2);
            // clamp for safety
            const clampX = Math.max(-vW / 2 + 2, Math.min(vW / 2 - 2, mapX));

            const pxX = vX + vW / 2 + clampX;
            ctx.fillStyle = hit.color;
            ctx.globalAlpha = 1.0 - ((now - hit.timestamp) / 3000); // fade out
            ctx.fillRect(pxX - 2, vY + 5, 4, vH - 10);
        }
        ctx.globalAlpha = 1.0;
    }

    if (shakeAmount > 0) {
        ctx.restore();
        shakeAmount -= 1;
        if (shakeAmount < 0) shakeAmount = 0;
    }

    if (leadInActive && !isPaused) {
        let curr = getGameTime();
        let cdown = Math.ceil(Math.abs(curr));
        if (cdown > 0) {
            ctx.font = "900 120px 'Outfit', sans-serif";
            ctx.textAlign = "center";
            ctx.fillStyle = '#ffffff';
            ctx.shadowBlur = 30;
            ctx.shadowColor = '#00e5ff';
            ctx.fillText(cdown, cw / 2, ch / 2);
            ctx.shadowBlur = 0;
        }
    }

    // Draw FPS and Frame Time (Debug Option)
    if (gameSettings.debugFPS) {
        ctx.save();
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(15, 80, 150, 45);
        ctx.strokeStyle = 'rgba(0, 229, 255, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(15, 80, 150, 45);

        ctx.fillStyle = '#00ffff';
        ctx.font = "bold 13px 'Inter', sans-serif";
        ctx.textAlign = 'left';
        ctx.fillText(`FPS: ${currentFps}`, 25, 98);
        ctx.fillStyle = '#ffffff';
        ctx.font = "12px 'Inter', sans-serif";
        ctx.fillText(`Frame: ${currentFrameTimeMs.toFixed(1)}ms`, 25, 114);
        ctx.restore();
    }

    if (gameSettings.debugNoteTimestamps) {
        ctx.save();
        const yPos = gameSettings.debugFPS ? 135 : 80;
        ctx.fillStyle = 'rgba(0, 0, 0, 0.75)';
        ctx.fillRect(15, yPos, 180, 45);
        ctx.strokeStyle = 'rgba(255, 0, 229, 0.5)';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(15, yPos, 180, 45);

        ctx.fillStyle = '#ff00e5';
        ctx.font = "bold 13px 'Inter', sans-serif";
        ctx.textAlign = 'left';
        ctx.fillText(`AUDIO TIME:`, 25, yPos + 18);
        ctx.fillStyle = '#ffffff';
        ctx.font = "bold 14px 'Inter', sans-serif";
        ctx.fillText(`${getGameTime().toFixed(3)}s`, 25, yPos + 36);
        ctx.restore();
    }

    requestAnimationFrame(gameLoop);
}

function registerHit(note, currentTime) {
    note.hit = true;
    hasHitForCurrentPress[note.lane] = true;
    playHitSound();

    const timeDiff = Math.abs(note.time - currentTime);
    const actualDiff = note.time - currentTime; // + if early, - if late
    const diffMs = Math.round(actualDiff * 1000);

    let accColor = '#00ffff'; // Perfect
    let accText = "PERFECT";

    if (Math.abs(diffMs) > 100) { accColor = '#ff8800'; accText = "OK"; }
    else if (Math.abs(diffMs) > 50) { accColor = '#ffff00'; accText = "GOOD"; }

    hitHistory.push({ diffMs: diffMs * -1, color: accColor, timestamp: performance.now() }); // invert so early is negative

    // Scoring logic
    combo++;
    if (combo >= 40) multiplier = 4;
    else if (combo >= 30) multiplier = 3;
    else if (combo >= 20) multiplier = 2;
    else if (combo >= 10) multiplier = 2;

    score += 25 * multiplier;

    // "Perfect" bonus precision and rating text
    if (timeDiff < 0.05) {
        score += 25 * multiplier;
        setRatingIndicator("PERFECT", '#00e5ff');
    } else if (Math.abs(diffMs) <= 100) {
        setRatingIndicator("GOOD", '#00ff00');
    } else {
        setRatingIndicator("OK", '#ff8800');
    }

    const { hitZoneY, hitZoneWidth: hzw } = getPerspectiveVars();
    const laneW = hzw / lanes;
    const fxX = cw / 2 - hzw / 2 + (note.lane * laneW) + (laneW / 2);

    // Spawn fire particles on the lane
    for (let i = 0; i < 15; i++) {
        hitParticles.push({
            x: fxX + (Math.random() - 0.5) * 20,
            y: hitZoneY,
            vx: (Math.random() - 0.5) * 6,
            vy: -Math.random() * 8,
            life: 1.0,
            color: Math.random() > 0.3 ? laneColors[note.lane] : '#ffffff',
            size: Math.random() * 6 + 3
        });
    }

    // Spawn neon shockwave
    hitShockwaves.push({
        x: fxX,
        y: hitZoneY,
        radius: 10,
        maxRadius: laneW * 0.9,
        color: laneColors[note.lane],
        alpha: 1.0,
        lineWidth: 4
    });

    updateHUD();
}

function updateAudioTrackIndicator() {
    const indicator = document.getElementById('audio-track-debug-indicator');
    if (!indicator) return;

    if (!gameActive || !gameSettings.debugAudioSwitch) {
        indicator.style.display = 'none';
        return;
    }

    indicator.style.display = 'inline-flex';
    if (currentAudioTrack === 'original') {
        indicator.innerHTML = '<span class="material-icons" style="font-size: 12px; margin-top: -1px;">audiotrack</span> YT ORIGINAL';
        indicator.style.color = '#00e5ff';
        indicator.style.background = 'rgba(0, 229, 255, 0.15)';
        indicator.style.border = '1px solid rgba(0, 229, 255, 0.3)';
    } else {
        indicator.innerHTML = '<span class="material-icons" style="font-size: 12px; margin-top: -1px;">graphic_eq</span> BEATGEN TRACK';
        indicator.style.color = '#ff9100';
        indicator.style.background = 'rgba(255, 145, 0, 0.15)';
        indicator.style.border = '1px solid rgba(255, 145, 0, 0.3)';
    }
}

async function switchAudio() {
    if (!gameActive || !gameSettings.debugAudioSwitch) return;

    // Resolve target track URLs if missing
    if (!originalAudioUrl && currentVideoId) {
        originalAudioUrl = await window.gameAPI.downloadAudio(currentVideoId);
    }
    if (!beatgenAudioUrl && currentVideoId) {
        const instPath = `../data/audio/${currentVideoId}_instrumental.wav`;
        const exists = await window.gameAPI.checkFileExists(instPath);
        if (exists) {
            beatgenAudioUrl = originalAudioUrl.replace('.wav', '_instrumental.wav');
        } else {
            beatgenAudioUrl = originalAudioUrl;
        }
    }

    // Toggle active track
    currentAudioTrack = (currentAudioTrack === 'original') ? 'beatgen' : 'original';
    const targetUrl = (currentAudioTrack === 'original') ? originalAudioUrl : beatgenAudioUrl;

    if (!targetUrl || audioPlayer.src === targetUrl) {
        updateAudioTrackIndicator();
        return;
    }

    const savedTime = audioPlayer.currentTime;
    const wasPlaying = !audioPlayer.paused;

    audioPlayer.src = targetUrl;

    const restoreTime = () => {
        if (!isNaN(savedTime) && savedTime > 0) {
            audioPlayer.currentTime = savedTime;
        }
        if (wasPlaying) {
            audioPlayer.play().catch(err => console.warn("[AUDIO SWITCH] Play error:", err));
        }
        audioPlayer.removeEventListener('loadedmetadata', restoreTime);
    };

    if (audioPlayer.readyState >= 1) {
        restoreTime();
    } else {
        audioPlayer.addEventListener('loadedmetadata', restoreTime);
    }

    updateAudioTrackIndicator();
    console.log(`[AUDIO SWITCH] Switched track to ${currentAudioTrack} at timestamp ${savedTime.toFixed(2)}s`);
}

// Input Handling
window.addEventListener('keydown', (e) => {
    // Intercept keys if rebinding keybind settings
    if (rebindingLaneIndex !== null || rebindingAudioSwitch) {
        e.preventDefault();
        e.stopPropagation();

        if (e.key === 'Escape') {
            updateKeybindButtons();
            rebindingLaneIndex = null;
            rebindingAudioSwitch = false;
            return;
        }

        const newKey = e.key.toLowerCase();

        // Check for duplicates
        let isDuplicate = false;

        // 1. Check against other note lanes
        if (gameSettings.keyBinds) {
            gameSettings.keyBinds.forEach((key, index) => {
                if (rebindingLaneIndex !== index && key.toLowerCase() === newKey) {
                    isDuplicate = true;
                }
            });
        }

        // 2. Check against the audio switch bind
        if (!rebindingAudioSwitch && gameSettings.audioSwitchBind && gameSettings.audioSwitchBind.toLowerCase() === newKey) {
            isDuplicate = true;
        }

        // 3. If rebinding the audio switch, check it against all note lanes
        if (rebindingAudioSwitch && gameSettings.keyBinds) {
            gameSettings.keyBinds.forEach((key) => {
                if (key.toLowerCase() === newKey) {
                    isDuplicate = true;
                }
            });
        }

        if (isDuplicate) {
            alert(`Key "${e.key.toUpperCase()}" is already bound to another function! Please choose a different key.`);
            return; // Stay in rebinding state
        }

        if (rebindingLaneIndex !== null) {
            // Save the rebound key
            gameSettings.keyBinds[rebindingLaneIndex] = e.key;
            rebindingLaneIndex = null;
        } else {
            // Save the audio switch key
            gameSettings.audioSwitchBind = e.key;
            rebindingAudioSwitch = false;
        }

        saveSettings();
        updateKeyMap();
        updateKeybindButtons();
        return;
    }

    if (e.key === 'Escape') {
        if (settingsModal && settingsModal.classList.contains('show')) {
            closeSettingsBtn.click();
            return;
        }
    }

    if (!gameActive) return;

    if (e.key === 'Escape') {
        togglePause();
        return;
    }

    if (isPaused) return;

    // --- DEBUG HOTKEYS ---
    // Instant Seek (Left = -5s, Right = +5s)
    if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const jump = e.key === 'ArrowLeft' ? -5 : 5;
        audioPlayer.currentTime = Math.max(0, audioPlayer.currentTime + jump);

        // Reset notes that are now in the future so they can be played again
        for (let i = 0; i < songMap.length; i++) {
            if (songMap[i].time > getGameTime() - missWindow) {
                songMap[i].hit = false;
                songMap[i].missed = false;
            }
        }

        hitHistory = []; // clear visualizer
        combo = 0;
        multiplier = 1;
        updateHUD();
        return;
    }

    // Audio Switch hotkey (Customized) - also available via in-game button
    if (gameSettings.audioSwitchBind && e.key.toLowerCase() === gameSettings.audioSwitchBind.toLowerCase()) {
        switchAudio();
        return;
    }
    // --- END DEBUG HOTKEYS ---

    const lane = keyMap[e.key];
    if (lane !== undefined) {
        if (e.repeat || activeKeys[lane]) return; // Prevent OS/browser key repeat spam and fast spamming
        lastUserInputTime = performance.now();
        activeKeys[lane] = true;
        hasHitForCurrentPress[lane] = false;

        // Find the *first* note in this lane that hasn't been hit and is within strike window
        const currentTime = getGameTime();
        const hitWindow = (gameSettings.hitWindow || 150) / 1000.0;

        // Look forward for the closest unhit note in the lane
        let closestNote = null;
        let minDiff = 999;

        for (let i = 0; i < songMap.length; i++) {
            let note = songMap[i];
            if (!note.hit && !note.missed && note.lane === lane) {
                const diff = Math.abs(note.time - currentTime);
                if (diff < hitWindow && diff < minDiff) {
                    minDiff = diff;
                    closestNote = note;
                }
            }
        }

        if (closestNote) {
            registerHit(closestNote, currentTime);
        } else {
            // Overstrum / Miss
            combo = 0;
            multiplier = 1;
            shakeAmount = 4;
            setRatingIndicator("MISS", '#ff0000');
            updateHUD();
        }
    }
});

window.addEventListener('keyup', (e) => {
    if (settingsModal && settingsModal.classList.contains('show')) return;
    const lane = keyMap[e.key];
    if (lane !== undefined) {
        lastUserInputTime = performance.now();
        activeKeys[lane] = false;
        hasHitForCurrentPress[lane] = false;
    }
});

function togglePause() {
    isPaused = !isPaused;
    if (isPaused) {
        if (leadInActive) {
            leadInPausedElapsed = (performance.now() - leadInStartTime) / 1000.0;
        } else {
            audioPlayer.pause();
            if (isYtPlayerReady && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
        }
        pauseMenu.style.display = 'flex';
    } else {
        if (leadInActive) {
            leadInStartTime = performance.now() - (leadInPausedElapsed * 1000.0);
        } else {
            audioPlayer.play();
            if (isYtPlayerReady && ytPlayer && ytPlayer.playVideo) ytPlayer.playVideo();
        }
        pauseMenu.style.display = 'none';
    }
}

resumeBtn.addEventListener('click', () => {
    if (isPaused) togglePause();
});

restartBtn.addEventListener('click', () => {
    pauseMenu.style.display = 'none';

    leadInActive = true;
    leadInStartTime = performance.now();
    audioPlayer.currentTime = 0;
    audioPlayer.pause();
    if (isYtPlayerReady && ytPlayer && ytPlayer.pauseVideo) ytPlayer.pauseVideo();
    if (isYtPlayerReady && ytPlayer && ytPlayer.seekTo) ytPlayer.seekTo(0);

    // reset map hit states
    for (let note of songMap) {
        note.hit = false;
        note.missed = false;
    }

    score = 0;
    combo = 0;
    multiplier = 1;
    shakeAmount = 0;
    hitEffects = [];
    hitParticles = [];
    hitShockwaves = [];
    activeRatingIndicator = null;
    lastUserInputTime = 0;
    activeKeys = { 0: false, 1: false, 2: false, 3: false, 4: false };
    hasHitForCurrentPress = { 0: false, 1: false, 2: false, 3: false, 4: false };
    updateHUD();

    isPaused = false;
});

mainMenuBtn.addEventListener('click', () => {
    endGame();
});

document.getElementById('stats-continue-btn').addEventListener('click', () => {
    closeGameAndReturnToMenu();
});

// --- MENU NEON PARTICLES ---
function initMenuParticles() {
    const menuCanvas = document.createElement('canvas');
    menuCanvas.id = 'menu-particles';
    menuCanvas.style.position = 'absolute';
    menuCanvas.style.top = '0';
    menuCanvas.style.left = '0';
    menuCanvas.style.width = '100%';
    menuCanvas.style.height = '100%';
    menuCanvas.style.zIndex = '1';
    menuCanvas.style.pointerEvents = 'none';

    const container = document.getElementById('url-input-container');
    if (container) {
        container.insertBefore(menuCanvas, container.firstChild);
    }

    const mctx = menuCanvas.getContext('2d');
    let mcw = menuCanvas.width = window.innerWidth;
    let mch = menuCanvas.height = window.innerHeight;

    window.addEventListener('resize', () => {
        if (!gameActive) {
            mcw = menuCanvas.width = window.innerWidth;
            mch = menuCanvas.height = window.innerHeight;
        }
    });

    const particles = [];
    const particleCount = 45;
    const colors = ['#00e5ff', '#00e676', '#ff0055', '#ffff00', '#d500f9'];

    class Particle {
        constructor() {
            this.reset();
            this.x = Math.random() * mcw;
            this.y = Math.random() * mch;
        }

        reset() {
            this.x = Math.random() * mcw;
            this.y = Math.random() * mch;
            this.radius = Math.random() * 3 + 1.5;
            this.speedX = (Math.random() - 0.5) * 0.45;
            this.speedY = (Math.random() - 0.5) * 0.45;
            this.color = colors[Math.floor(Math.random() * colors.length)];
            this.alpha = Math.random() * 0.4 + 0.15;
            this.glow = Math.random() * 10 + 5;
        }

        update() {
            this.x += this.speedX;
            this.y += this.speedY;

            if (this.x < 0 || this.x > mcw) this.speedX *= -1;
            if (this.y < 0 || this.y > mch) this.speedY *= -1;
        }

        draw() {
            mctx.save();
            mctx.shadowBlur = this.glow;
            mctx.shadowColor = this.color;
            mctx.fillStyle = this.color;
            mctx.globalAlpha = this.alpha;
            mctx.beginPath();
            mctx.arc(this.x, this.y, this.radius, 0, Math.PI * 2);
            mctx.fill();
            mctx.restore();
        }
    }

    for (let i = 0; i < particleCount; i++) {
        particles.push(new Particle());
    }

    let mouse = { x: null, y: null };
    window.addEventListener('mousemove', (e) => {
        if (!gameActive) {
            mouse.x = e.clientX;
            mouse.y = e.clientY;
        }
    });

    window.addEventListener('mouseleave', () => {
        mouse.x = null;
        mouse.y = null;
    });

    function animateMenu() {
        if (gameActive) {
            requestAnimationFrame(animateMenu);
            return;
        }

        mctx.clearRect(0, 0, mcw, mch);

        // Draw connection lines
        mctx.lineWidth = 0.5;
        for (let i = 0; i < particles.length; i++) {
            for (let j = i + 1; j < particles.length; j++) {
                const dx = particles[i].x - particles[j].x;
                const dy = particles[i].y - particles[j].y;
                const dist = Math.sqrt(dx * dx + dy * dy);

                if (dist < 120) {
                    const alpha = (1 - (dist / 120)) * 0.12;
                    mctx.strokeStyle = particles[i].color;
                    mctx.globalAlpha = alpha;
                    mctx.beginPath();
                    mctx.moveTo(particles[i].x, particles[i].y);
                    mctx.lineTo(particles[j].x, particles[j].y);
                    mctx.stroke();
                }
            }
        }
        mctx.globalAlpha = 1.0;

        // Update and draw particles
        particles.forEach(p => {
            p.update();

            if (mouse.x !== null && mouse.y !== null) {
                const dx = mouse.x - p.x;
                const dy = mouse.y - p.y;
                const dist = Math.sqrt(dx * dx + dy * dy);
                if (dist < 100) {
                    const force = (100 - dist) / 100;
                    p.x -= (dx / dist) * force * 0.8;
                    p.y -= (dy / dist) * force * 0.8;
                }
            }

            p.draw();
        });

        requestAnimationFrame(animateMenu);
    }
    animateMenu();
}

// Initialize on load
initMenuParticles();

