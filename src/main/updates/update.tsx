import { updateElectronApp, UpdateSourceType } from 'update-electron-app';
import electron, { autoUpdater } from 'electron';

export function startAutoUpdate() {
  // Handle update-downloaded event
  autoUpdater.on('update-downloaded', (event, releaseNotes, releaseName) => {
    // Yolo I guess 🤷‍♀️
    autoUpdater.quitAndInstall();
  });

  updateElectronApp({
    updateInterval: '10 minutes',
    notifyUser: false, // We'll handle this ourselves ;)
  });
}

export function updateNow() {
  autoUpdater.checkForUpdates();
}
