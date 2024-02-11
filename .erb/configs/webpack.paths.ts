const path = require('path');

const rootPath = path.join(__dirname, '../..');

const dllPath = path.join(__dirname, '../dll');

const srcPath = path.join(rootPath, 'src');
const srcMainPath = path.join(srcPath, 'main');
const srcRendererPath = path.join(srcPath, 'renderer');
const srcBgThreadsPath = path.join(srcPath, 'background_threads');

const releasePath = path.join(rootPath, 'release');
const appPath = path.join(releasePath, 'app');
const appPackagePath = path.join(appPath, 'package.json');
const appNodeModulesPath = path.join(appPath, 'node_modules');
const srcNodeModulesPath = path.join(srcPath, 'node_modules');

const distPath = path.join(appPath, 'dist');
const distMainPath = path.join(distPath, 'main');
const distRendererPath = path.join(distPath, 'renderer');
const distBgThreadsPath = path.join(distPath, 'background_threads');

const buildPath = path.join(releasePath, 'build');

export default {
    rootPath,
    dllPath,
    srcPath,
    srcMainPath,
    srcRendererPath,
    srcBgThreadsPath,
    releasePath,
    appPath,
    appPackagePath,
    appNodeModulesPath,
    srcNodeModulesPath,
    distPath,
    distMainPath,
    distRendererPath,
    distBgThreadsPath,
    buildPath,
};
