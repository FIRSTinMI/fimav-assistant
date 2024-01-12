import {
  app,
  Menu,
  shell,
  BrowserWindow,
  MenuItemConstructorOptions,
  MenuItem,
} from 'electron';

interface DarwinMenuItemConstructorOptions extends MenuItemConstructorOptions {
  selector?: string;
  submenu?: DarwinMenuItemConstructorOptions[] | Menu;
}

export default class MenuBuilder {
  mainWindow: BrowserWindow;

  constructor(mainWindow: BrowserWindow) {
    this.mainWindow = mainWindow;
  }

  buildMenu(): Menu {
    const isDev =
      process.env.NODE_ENV === 'development' ||
      process.env.DEBUG_PROD === 'true';

    const template = this.buildDefaultTemplate(isDev);

    const menu = Menu.buildFromTemplate(template);
    Menu.setApplicationMenu(menu);

    return menu;
  }

  buildDefaultTemplate(dev: boolean) {
    const templateDefault: any = [
      {
        label: 'About',
        submenu: [
          {
            label: 'FIRST in Michigan',
            click() {
              shell.openExternal('https://www.firstinmichigan.org');
            },
          },
        ],
      },
    ];

    if (dev) {
      templateDefault.push({
        label: 'Debug',
        submenu: [
          {
            label: 'Reload',
            accelerator: 'CommandOrControl+R',
            click: () => {
              BrowserWindow.getFocusedWindow()?.webContents.reload();
            },
          },
          {
            label: 'Toggle Developer Tools',
            accelerator: 'Alt+CommandOrControl+I',
            click: () => {
              BrowserWindow.getFocusedWindow()?.webContents.toggleDevTools();
            },
          },
        ],
      });
    }

    return templateDefault;
  }
}
