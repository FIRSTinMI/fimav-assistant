/* eslint import/prefer-default-export: off */
import { URL } from 'url';
import path from 'path';
import { app } from 'electron';
import { LogFunctions } from 'electron-log';
import { LogLevel } from '@microsoft/signalr';
import { hostname } from 'os';
import { exec } from 'child_process';

export function resolveHtmlPath(
    htmlFileName: string,
    anchor: string | null = null
) {
    if (process.env.NODE_ENV === 'development') {
        const port = process.env.PORT || 1212;
        const url = new URL(`http://localhost:${port}`);
        url.pathname = htmlFileName;
        if (anchor) url.hash = anchor;
        return url.href;
    }
    return `file://${path.resolve(
        __dirname,
        '../renderer/',
        htmlFileName
    )}${(anchor ? `#${anchor}` : '')}`;
}

export const RESOURCES_PATH = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '../../assets');

export function getAssetPath(...paths: string[]): string {
    return path.join(RESOURCES_PATH, ...paths);
}

export const getResourcePath = (...paths: string[]): string => {
    return path.join(RESOURCES_PATH, ...paths);
};

export const signalrToElectronLog = (
    log: LogFunctions | null,
    logLevel: LogLevel,
    message: string
): void => {
    if (log === null) return;
    switch (logLevel) {
    case LogLevel.Debug:
    case LogLevel.Trace:
        if (isDebug()) log.info(message);
        break;
    case LogLevel.Information:
        log.info(message);
        break;
    case LogLevel.Warning:
        log.warn(message);
        break;
    case LogLevel.Error:
        log.error(message);
        break;
    case LogLevel.Critical:
        log.error(message);
        break;
    case LogLevel.None:
        log.info(message);
        break;
    default:
        break;
    }
};

export const getCartNumberFromHostname = (): number => {
    // Get Computer Name
    const whoAmI = hostname().toLowerCase();

    // AV Carts are maned FIMAV<number>, so lets determine which cart we are
    let cartNumber = parseInt(whoAmI.replace(/\D/g, ''), 10);

    // If we are not a cart, we are 0
    if (Number.isNaN(cartNumber)) cartNumber = 0;

    return cartNumber;
}

export const isDebug = () => process.env.NODE_ENV === 'development' || process.env.DEBUG_PROD === 'true';

export const appdataPath = app.getPath('userData');
export const logsPath = app.getPath('logs');


export const elevatedPSCommand = (command: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        exec(`powershell -Command "& {Start-Process powershell -windowstyle hidden -Verb RunAs -ArgumentList '-Command ${command}'}"`, (error: any, stdout: any, stderr: any) => {
            if (error) {
                reject(error);
            }
            if (stderr) {
                reject(stderr);
            }
            resolve(stdout);
        });
    });
}

export const psCommand = (command: string): Promise<string> => {
    return new Promise((resolve, reject) => {
        exec(`powershell -Command "${command.replaceAll('"', '\\"')}"`, (error: any, stdout: any, stderr: any) => {
            if (error) {
                reject(error);
            }
            if (stderr) {
                reject(stderr);
            }
            resolve(stdout);
        });
    });
}