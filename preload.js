const { contextBridge, ipcRenderer } = require('electron');
// Expose safe APIs to the renderer process
contextBridge.exposeInMainWorld('gameAPI', {
    saveMapData: (videoId, data) => ipcRenderer.invoke('save-map-data', videoId, data),
    loadMapData: (videoId, difficulty) => ipcRenderer.invoke('load-map-data', videoId, difficulty),
    saveRawNotes: (videoId, rawNotes) => ipcRenderer.invoke('save-raw-notes', videoId, rawNotes),
    loadRawNotes: (videoId) => ipcRenderer.invoke('load-raw-notes', videoId),
    searchYouTube: (query) => ipcRenderer.invoke('search-youtube', query),
    downloadAudio: (videoId) => ipcRenderer.invoke('download-audio', videoId),
    getCachedSongs: () => ipcRenderer.invoke('get-cached-songs'),
    saveCachedSong: (songData) => ipcRenderer.invoke('save-cached-song', songData),
    deleteCachedSong: (videoId) => ipcRenderer.invoke('delete-cached-song', videoId),
    deleteCachedSongDifficulty: (videoId, difficulty) => ipcRenderer.invoke('delete-cached-song-difficulty', videoId, difficulty),
    cancelActiveDownloads: () => ipcRenderer.invoke('cancel-active-downloads'),
    deleteAllCachedSongs: () => ipcRenderer.invoke('delete-all-cached-songs'),
    separateAudioStems: (videoId) => ipcRenderer.invoke('separate-audio-stems', videoId),
    analyzeStructure: (videoId) => ipcRenderer.invoke('analyze-structure', videoId),
    loadEngineParams: () => ipcRenderer.invoke('load-engine-params'),
    saveBeatGenLog: (logString) => ipcRenderer.invoke('save-beatgen-log', logString),
    clearAllLogs: () => ipcRenderer.invoke('clear-all-logs'),
    checkFileExists: (filePath) => ipcRenderer.invoke('check-file-exists', filePath),
    readFileBuffer: (path) => ipcRenderer.invoke('read-file-buffer', path),
    loadUserStats: () => ipcRenderer.invoke('load-user-stats'),
    saveUserStats: (data) => ipcRenderer.invoke('save-user-stats', data),
    onDownloadProgress: (callback) => ipcRenderer.on('download-progress', (_event, value) => callback(value)),
    onCachedSongsUpdated: (callback) => ipcRenderer.on('cached-songs-updated', (_event) => callback()),
    saveSettings: (settings) => ipcRenderer.invoke('save-settings', settings),
    setZoomFactor: (factor) => require('electron').webFrame.setZoomFactor(factor)
});

window.addEventListener('keydown', (e) => {
    if (e.ctrlKey && (e.key === '=' || e.key === '-' || e.key === '+')) {
        e.preventDefault();
    }
});
window.addEventListener('wheel', (e) => {
    if (e.ctrlKey) {
        e.preventDefault();
    }
}, { passive: false });
