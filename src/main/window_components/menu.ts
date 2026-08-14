/* eslint-disable import/order */
import {
    Menu,
    shell,
    BrowserWindow,
    MenuItemConstructorOptions,
} from 'electron';
import Addons from 'main/addons';
import { platform } from 'os';
import { updateNow } from '../updates/update';
import { isDebug, logsPath } from '../util';
import { quitApp } from '../main'; // eslint-disable-line import/no-cycle
import AutoAV from '../addons/autoav';

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
        const template = this.buildDefaultTemplate(isDebug());

        const menu = Menu.buildFromTemplate(template);
        Menu.setApplicationMenu(menu);

        return menu;
    }

    // eslint-disable-next-line class-methods-use-this
    buildDefaultTemplate(dev: boolean) {
        const templateDefault: MenuItemConstructorOptions[] = [];

        if (platform() === 'darwin') {
            templateDefault.push({
                label: 'FiM AV Assistant',
                role: 'appMenu',
                submenu: [
                    {
                        label: 'About FiM AV Assistant',
                        role: 'about',
                    },
                    ...(dev
                        ? ([
                              {
                                  label: 'Quit',
                                  role: 'quit',
                                  click() {
                                      quitApp();
                                  },
                              },
                          ] as MenuItemConstructorOptions[])
                        : []),
                ],
            });
        }

        templateDefault.push(
            ...([
                // Alerts now live in the tab-bar notification bell.
                // vMix controls now live in the vMix tab. Only the dev-only
                // manual recording triggers remain, behind the dev flag.
                ...(dev
                    ? ([
                          {
                              label: 'vMix (Dev)',
                              submenu: [
                                  {
                                      label: 'Start Recording (Dev)',
                                      click() {
                                          AutoAV.Instance.devStartRecording();
                                      },
                                  },
                                  {
                                      label: 'Stop Recording (Dev)',
                                      click() {
                                          AutoAV.Instance.devStopRecording();
                                      },
                                  },
                              ],
                          },
                      ] as MenuItemConstructorOptions[])
                    : []),
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
                        {
                            label: 'Quit',
                            accelerator: 'CommandOrControl+Alt+Shift+X',
                            visible: false,
                            click() {
                                quitApp();
                            },
                        },
                    ],
                },
            ] as MenuItemConstructorOptions[])
        );

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

    static openLiveCapSettings(submenu: string = '') {
        const window = new BrowserWindow({
            width: 1200,
            height: 800,
            alwaysOnTop: false,
            resizable: false,
            minimizable: true,
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
