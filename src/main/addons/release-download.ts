import path from 'path';
import fs from 'fs';
import { finished } from 'stream/promises';
import { Readable } from 'node:stream';
import glob from 'glob';
import { LogFunctions } from 'electron-log';
import { appdataPath } from '../util';

// Shared plumbing for the addons that run a versioned Windows exe downloaded
// from GitHub releases (LiveCaptions, YoutubeUploaderAddon,
// AudienceDisplayAddon): version parsing and comparison, the update check and
// the download.

const VERSION_RE = /^\d+\.\d+\.\d+$/;

export const isVersion = (v: string): boolean => VERSION_RE.test(v);

// Numeric semver compare of two x.y.z strings: <0, 0 or >0. A plain string
// compare puts '0.10.0' below '0.9.0'.
export function compareVersions(a: string, b: string): number {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i += 1) {
        const d = (pa[i] || 0) - (pb[i] || 0);
        if (d !== 0) return d;
    }
    return 0;
}

// Newest <name>-<x.y.z>.exe already downloaded into userData, or '0.0.0' when
// there is none. Names that do not carry a clean version are ignored.
export function newestLocalVersion(name: string): string {
    let current = '0.0.0';
    glob.sync(path.join(appdataPath, `${name}-*.exe`)).forEach((file) => {
        const v = path.basename(file).slice(name.length + 1, -'.exe'.length);
        if (isVersion(v) && compareVersions(v, current) > 0) current = v;
    });
    return current;
}

// Version of the newest release: GitHub's /latest redirects to .../tag/vX.Y.Z.
// Throws on a network error or a non-2xx answer; returns null when the final
// URL does not end in a clean vX.Y.Z tag (treated as "no update").
export async function latestReleaseVersion(
    baseUrl: string
): Promise<string | null> {
    const res = await fetch(`${baseUrl}/latest`, {
        signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw new Error(`Update check: HTTP ${res.status}`);
    const tag = res.url.split('/').pop() ?? '';
    const m = /^v(\d+\.\d+\.\d+)$/.exec(tag);
    return m ? m[1] : null;
}

export interface UpdateInfo {
    current: string;
    latest: string;
    updateAvailable: boolean;
}

// Compare the newest downloaded <name> exe with the newest release, without
// downloading anything. Best-effort: offline at a venue, or when the release
// tag is not a clean version, latest is the local version and no update is
// reported.
export async function checkForUpdate(
    name: string,
    baseUrl: string,
    logger: LogFunctions
): Promise<UpdateInfo> {
    const current = newestLocalVersion(name);
    let latest = current;
    try {
        latest = (await latestReleaseVersion(baseUrl)) ?? current;
    } catch (e) {
        logger.warn(`Update check failed, using local v${current}`, e);
    }
    return {
        current,
        latest,
        updateAvailable: compareVersions(latest, current) > 0,
    };
}

// Download <baseUrl>/download/v<version>/<name>-<version>.exe into userData.
// The bytes go to a .part file that is renamed only once the download is
// complete, so a failed or cut-off download never leaves a broken exe under
// the name start() launches.
export async function downloadRelease(
    baseUrl: string,
    name: string,
    version: string
): Promise<void> {
    const target = path.join(appdataPath, `${name}-${version}.exe`);
    const part = `${target}.part`;
    try {
        const res = await fetch(
            `${baseUrl}/download/v${version}/${name}-${version}.exe`,
            { signal: AbortSignal.timeout(15 * 60 * 1000) }
        );
        if (!res.ok || res.body === null) {
            throw new Error(`Download of ${name}: HTTP ${res.status}`);
        }
        // Node's Readable.fromWeb typing lags the DOM stream type.
        const body = Readable.fromWeb(res.body as any);
        await finished(body.pipe(fs.createWriteStream(part)));
        fs.renameSync(part, target);
    } catch (e) {
        try {
            fs.rmSync(part, { force: true });
        } catch {
            // nothing to clean up
        }
        throw e;
    }
}
