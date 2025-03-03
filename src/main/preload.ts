// Disable no-unused-vars, broken for spread args
/* eslint no-unused-vars: off */
import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron';

const electronHandler = {
    ipcRenderer: {
        sendMessage(channel: string, args: unknown[]) {
            ipcRenderer.send(channel, args);
        },

        on(channel: string, func: (...args: any[]) => void) {
            const subscription = (_event: IpcRendererEvent, ...args: any[]) =>
                func(...args);

            ipcRenderer.on(channel, subscription);

            return () => {
                ipcRenderer.removeListener(channel, subscription);
            };
        },
        once<d>(channel: string, func: (args: d) => void) {
            ipcRenderer.once(channel, (_event, args) => func(args));
        },
        removeListener(channel: string, func: (...args: any[]) => void) {
            ipcRenderer.removeListener(channel, func);
        },
    },
};

contextBridge.exposeInMainWorld('electron', electronHandler);

export type ElectronHandler = typeof electronHandler;
