/* eslint import/prefer-default-export: off */
import { URL } from 'url';
import path from 'path';
import { app } from 'electron';

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

export const appdataPath = app.getPath('userData');