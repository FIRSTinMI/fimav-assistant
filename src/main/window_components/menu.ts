import {
    Menu,
    shell,
    BrowserWindow,
    MenuItemConstructorOptions,
} from 'electron';
import Addons from 'main/addons';
import path from 'path';
import { updateNow } from '../updates/update';
import { logsPath } from '../util';

interface DarwinMenuItemConstructorOptions extends MenuItemConstructorOptions {
    selector?: string;
    submenu?: DarwinMenuItemConstructorOptions[] | Menu;
}

export default class MenuBuilder {
    mainWindow: BrowserWindow;

    addons: Addons;

    constructor(mainWindow: BrowserWindow, addons: Addons) {
        this.mainWindow = mainWindow;
        this.addons = addons;
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
        const that = this;
        const templateDefault: any = [
            {
                label: 'Addons',
                submenu: [
                    {
                        label: 'Live Captions',
                        submenu: [
                            {
                                label: 'Restart',
                                click() {
                                    that.addons.restartLiveCaptions();
                                },
                            },
                            {
                                label: 'Settings',
                                click() {
                                    that.openLiveCapSettings();
                                },
                            },
                            {
                                label: 'About',
                                click() {
                                    that.openLiveCapSettings('about');
                                },
                            },
                        ],
                    },
                    {
                        label: 'AutoAV',
                        submenu: [
                            {
                                label: 'Restart',
                                click() {
                                    that.addons.restartAutoAV();
                                },
                            },
                        ],
                    },
                    {
                        label: 'Restart All',
                        click() {
                            that.addons.restartAll();
                        },
                    },
                ],
            },
            {
                label: 'About',
                submenu: [
                    {
                        label: 'FIRST in Michigan',
                        click() {
                            shell.openExternal(
                                'https://www.firstinmichigan.org'
                            );
                        },
                    },
                    {
                        label: 'View Logs',
                        click() {
                            shell.openPath(logsPath);
                        },
                    },
                    {
                        label: 'Check for Updates (app may restart)',
                        click() {
                            updateNow();
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

    openLiveCapSettings(submenu: string = '') {
        const window = new BrowserWindow({
            width: 1200,
            height: 800,
            alwaysOnTop: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            fullscreenable: false,
            autoHideMenuBar: true,
            title: 'Live Captions',
            webPreferences: {
                // preload: `Array.from(document.getElementsByClassName("tabs")).forEach(c => c.remove())`
            },
        });
        window.loadURL(`http://localhost:3000/settings.html#${submenu}`);
        window.show();
    }
}
