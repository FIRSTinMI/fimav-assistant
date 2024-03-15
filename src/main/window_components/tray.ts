import { Menu, Tray, BrowserWindow } from 'electron';
import path from 'path';

export default function buildTray(
    mainWindow: BrowserWindow | null,
    RESOURCES_PATH: string,
    version: string
) {
    const tray = new Tray(path.join(RESOURCES_PATH, 'icon.ico'));
    const contextMenu = Menu.buildFromTemplate([
        {
            label: 'Show AV Assistant',
            type: 'normal',
            click: () => mainWindow?.show(),
        },
    ]);
    let tooltip = 'FIM AV Assistant\n';
    tooltip += `Version: ${version}\n`;
    tooltip += 'FMS IP: 10.0.100.5\n';
    tooltip += 'AV Internet IP: Unknown\n';
    tooltip += 'AV Field IP: Unknown';
    tray.setToolTip(tooltip);
    tray.setContextMenu(contextMenu);
    tray.addListener('click', () => {
        mainWindow?.show();
    });

    return tray;
}
