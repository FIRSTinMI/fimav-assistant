import { IpcMain } from "electron";
import HWCheck from "./events/HWCheck";

// Use this file to register all events. For uniformity, all events should send their response as <event-name>-response

export function registerAllEvents(ipc: IpcMain) {
    ipc.on("hwcheck", (event, arg) => {
        const out = HWCheck();
        event.reply("hwcheck-response", out);
    });
}