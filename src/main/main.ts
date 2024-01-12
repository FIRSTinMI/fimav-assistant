/* eslint global-require: off, no-console: off, promise/always-return: off */

/**
 * This module executes inside of electron's main process. You can start
 * electron renderer process from here and communicate with the other processes
 * through IPC.
 *
 * When running `npm run build` or `npm run build:main`, this file is compiled to
 * `./src/main.js` using webpack. This gives us some performance wins.
 */
import path from 'path';
import {
  app,
  BrowserWindow,
  shell,
  ipcMain,
  Tray,
  Menu,
  globalShortcut,
  screen
} from 'electron';
import { autoUpdater } from 'electron-updater';
import log from 'electron-log';
import MenuBuilder from './window_components/menu';
import { resolveHtmlPath } from './util';
import { registerAllEvents } from './register-events';
import { createStore } from './store';
import setupSignalR from './window_components/signalR';

class AppUpdater {
  constructor() {
    log.transports.file.level = 'info';
    autoUpdater.logger = log;
    autoUpdater.checkForUpdatesAndNotify();
  }
}

let mainWindow: BrowserWindow | null = null;
let alertsWindow: BrowserWindow | null = null;
let tray = null;
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

const RESOURCES_PATH = app.isPackaged
  ? path.join(process.resourcesPath, 'assets')
  : path.join(__dirname, '../../assets');

const getAssetPath = (...paths: string[]): string => {
  return path.join(RESOURCES_PATH, ...paths);
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

/** Create the window which shows pending alerts. Note: this window is a singleton */
const createAlertsWindow = async () => {
  if (alertsWindow != null) return;
  const display = screen.getPrimaryDisplay();
  const width = display.bounds.width;
  const windowWidth = Math.round(width * 0.25);
  alertsWindow = new BrowserWindow({
    show: false,
    width: windowWidth,
    height: 400,
    // Top right of primary screen
    x: width - windowWidth,
    y: 0,
    minimizable: false,
    closable: true,
    maximizable: false,
    fullscreenable: false,
    alwaysOnTop: true,
    title: 'Alerts',
    icon: getAssetPath('icon.png'),
    webPreferences: {
      preload: app.isPackaged
        ? path.join(__dirname, 'preload.js')
        : path.join(__dirname, '../../.erb/dll/preload.js'),
    },
  });

  alertsWindow.loadURL(resolveHtmlPath('index.html', '/alerts/'));

  alertsWindow.on('ready-to-show', () => {
    if (!alertsWindow) {
      throw new Error('"alertsWindow" is not defined');
    }
    alertsWindow.show();
  });

  alertsWindow.on('closed', () => {
    alertsWindow = null;
  });
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
    tray = new Tray(path.join(RESOURCES_PATH, 'icon.png'));
    const contextMenu = Menu.buildFromTemplate([
      {
        label: 'Show AV Assistant',
        type: 'normal',
        click: () => mainWindow?.show(),
      },
    ]);
    let tooltip = 'FIM AV Assistant\n';
    tooltip += `Version: ${app.getVersion()}\n`;
    tooltip += 'FMS IP: 10.0.100.5\n';
    // tooltip += 'AV Internet IP: Unknown\n';
    // tooltip += 'AV Field IP: Unknown';
    tray.setToolTip(tooltip);
    tray.setContextMenu(contextMenu);

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

export { alertsWindow };