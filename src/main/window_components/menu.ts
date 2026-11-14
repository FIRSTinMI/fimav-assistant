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

    // "Checks", or "Checks (2)" while two checks are failing.
    checksLabel = 'Checks';

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

    // Rebuild the menu when the number of failing checks changes.
    setChecksAlerts(count: number) {
        const label = count ? `Checks (${count})` : 'Checks';
        if (label === this.checksLabel) return;
        this.checksLabel = label;
        this.buildMenu();
    }

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
                    label: 'Settings',
                    click: () => {
                        this.mainWindow.webContents.send('app:openSettings');
                    },
                },
                {
                    label: this.checksLabel,
                    click: () => {
                        this.mainWindow.webContents.send('app:openChecks');
                    },
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
}
