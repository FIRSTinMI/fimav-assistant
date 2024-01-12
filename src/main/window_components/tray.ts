import { Menu, Tray } from "electron";
import path from "path";


export default function buildTray(mainWindow: Electron.BrowserWindow | null, RESOURCES_PATH: string, version: string) {
    const tray = new Tray(path.join(RESOURCES_PATH, 'icon.png'));
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

    return tray;
}