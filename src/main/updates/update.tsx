import { updateElectronApp } from 'update-electron-app';
import { autoUpdater } from 'electron';

export function startAutoUpdate() {
  // Handle update-downloaded event
  autoUpdater.on('update-downloaded', () => {
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
