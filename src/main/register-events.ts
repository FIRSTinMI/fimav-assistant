import { IpcMain } from 'electron';
import HWCheck from './events/HWCheck';

// Use this file to register all events. For uniformity, all events should send their response as <event-name>-response

export default function registerAllEvents(ipc: IpcMain) {
  ipc.on('hwcheck', async (event) => {
    const out = await HWCheck();
    event.reply('hwcheck-response', out);
  });
}
