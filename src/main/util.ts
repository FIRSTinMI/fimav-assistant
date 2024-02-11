/* eslint import/prefer-default-export: off */
import { URL } from 'url';
import path from 'path';
import { app } from 'electron';
import { LogFunctions } from 'electron-log';
import { LogLevel } from '@microsoft/signalr';

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
  return `file://${path.resolve(__dirname, '../renderer/', htmlFileName + (anchor ? `#${anchor}` : ''))}`;
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

export const signalrToElectronLog = (log: LogFunctions | null, logLevel: LogLevel, message: string): void => {
  if (log === null) return;
  switch (logLevel) {
    case LogLevel.Trace:
      log.info(message);
      break;
    case LogLevel.Debug:
      log.info(message);
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
    }
}

export const appdataPath = app.getPath('userData');
export const logsPath = app.getPath('logs');