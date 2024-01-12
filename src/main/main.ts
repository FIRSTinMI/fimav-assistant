/* eslint global-require: off, no-console: off, promise/always-return: off */
import path from 'path';
import { app, BrowserWindow, shell, ipcMain, globalShortcut } from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import MenuBuilder from './window_components/menu';
import { RESOURCES_PATH, getAssetPath, resolveHtmlPath } from './util';
import { registerAllEvents } from './register-events';
import { createStore } from './store';
import setupSignalR from './window_components/signalR';
import buildTray from './window_components/tray';
import createAlertsWindow from './window_components/alertsWindow';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;
let appIsQuitting = false;

// Register all the event handlers
registerAllEvents(ipcMain);

if (process.env.NODE_ENV === 'production') {
  const sourceMapSupport = require('source-map-support');
  sourceMapSupport.install();
}

const isDebug =
  process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

if (isDebug) {
  require('electron-debug')({ showDevTools: false });
}

const installExtensions = async () => {
  const installer = require('electron-devtools-installer');
  const forceDownload = !!process.env.UPGRADE_EXTENSIONS;
  const extensions: string[] = [];

  return installer
    .default(
      extensions.map((name) => installer[name]),
      forceDownload
    )
    .catch(console.log);
};

/** Create the main window */
const createWindow = async () => {
  if (isDebug) {
    await installExtensions();
  }

  mainWindow = new BrowserWindow({
    show: false,
    width: 1024,
    height: 728,
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  mainWindow.loadURL(resolveHtmlPath('index.html'));

  mainWindow.on('ready-to-show', () => {
    if (!mainWindow) {
      throw new Error('"mainWindow" is not defined');
    }
    mainWindow.show();
    mainWindow.focus();
  });

  mainWindow.on('minimize', (event: any) => {
    event.preventDefault();
    mainWindow?.hide();
  });

  mainWindow.on('close', (event) => {
    if (!appIsQuitting) {
      event.preventDefault();
      mainWindow?.hide();
      return false;
    }
    mainWindow?.destroy();

    return true;
  });

  const menuBuilder = new MenuBuilder(mainWindow);
  menuBuilder.buildMenu();

  // Open urls in the user's browser
  mainWindow.webContents.setWindowOpenHandler((edata) => {
    shell.openExternal(edata.url);
    return { action: 'deny' };
  });

  // Remove this if your app does not use auto updates
  // eslint-disable-next-line
  new AppUpdater();
};

/**
 * Add event listeners...
 */
app.on('window-all-closed', () => {
  // app.quit();
});

app
  .whenReady()
  .then(() => {
    createWindow();
    const store = createStore();

    // Register Shortcuts
    if (!app.isPackaged) {
      // Ctrl + Q to quit
      globalShortcut.register('CommandOrControl+Q', () => {
        appIsQuitting = true;
        app.quit();
      });
    }

    // Register Tray Icon
    buildTray(mainWindow, RESOURCES_PATH, app.getVersion());

    // TODO: Currently the API key is set manually by opening the config.json file
    if (store.get('apiKey')) {
      setupSignalR(store, createAlertsWindow);
    }

    app.on('activate', () => {
      // On macOS it's common to re-create a window in the app when the
      // dock icon is clicked and there are no other windows open.
      if (mainWindow === null) createWindow();
    });
  })
  .catch(console.log);
