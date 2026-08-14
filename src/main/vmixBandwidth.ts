import fs from 'fs';
import path from 'path';
import log from 'electron-log';

export interface VmixStream {
    // vMix stream index (from the log filename: "streaming<N> ...")
    index: number;
    // Target/max video bitrate in kbps parsed from the ffmpeg command line
    targetKbps: number | null;
    maxrateKbps: number | null;
    // Live bitrate in kbps = the last bitrate= value in the ffmpeg log
    liveKbps: number | null;
    // Friendly destination label (e.g. "YouTube (primary)")
    destination: string;
    // Full rtmp URL ffmpeg is streaming to (includes the stream key)
    rtmpUrl: string;
}

export interface VmixBandwidth {
    streams: VmixStream[];
    supported: boolean;
    // True on the first poll after logs appear, when there is no prior size to
    // compare against yet, so activity can't be judged this tick. The UI keeps
    // the loading spinner up until this clears.
    warming?: boolean;
}

export function streamKeyFromUrl(url: string): string {
    const noQuery = url.split('?')[0];
    return noQuery.split('/').filter(Boolean).pop() ?? '';
}

const LOG_DIR = 'C:\\ProgramData\\vMix\\streaming';

// Per-log file size seen on the previous poll, keyed by full path. A stream is
// "active" when its log grew since the last poll (~3s ago) - no in-call sleep
// and no background loop needed, just compare against last time.
const lastSize = new Map<string, number>();

function labelDestination(commandLine: string): string {
    const rtmp = /rtmp:\/\/([^/"\s]+)/i.exec(commandLine);
    const host = rtmp?.[1] ?? '';
    if (/backup=1/i.test(commandLine) || /^b\./i.test(host)) {
        return 'YouTube (backup)';
    }
    if (/youtube/i.test(host) || /^a\./i.test(host)) {
        return 'YouTube (primary)';
    }
    return host || 'Unknown';
}

function rtmpUrl(commandLine: string): string {
    const m = /rtmp:\/\/[^\s"]+/i.exec(commandLine);
    return m?.[0] ?? '';
}

function parseKbps(commandLine: string, flag: string): number | null {
    const re = new RegExp(`${flag}\\s+(\\d+)k`, 'i');
    const m = re.exec(commandLine);
    return m ? parseInt(m[1], 10) : null;
}

// Newest log file per stream slot. vMix names them "streaming<N> <timestamp>.log"
// so the lexically-highest name per slot is the most recent one.
function newestLogs(): { index: number; file: string }[] {
    let names: string[];
    try {
        names = fs.readdirSync(LOG_DIR);
    } catch {
        return [];
    }
    const bySlot = new Map<number, string>();
    names.forEach((name) => {
        const m = /^streaming(\d+).*\.log$/i.exec(name);
        if (!m) return;
        const idx = parseInt(m[1], 10);
        const cur = bySlot.get(idx);
        if (!cur || name > cur) bySlot.set(idx, name);
    });
    return [...bySlot.entries()].map(([index, name]) => ({
        index,
        file: path.join(LOG_DIR, name),
    }));
}

// Read the current size + head (ffmpeg command line) + tail (progress lines)
// off an OPEN handle. libuv opens with full share flags so this works while
// ffmpeg holds the log open, and fstat returns the true current EOF (unlike
// directory metadata, which NTFS leaves stale for open files).
function readParts(
    file: string
): { size: number; head: string; tail: string } | null {
    let fd: number | undefined;
    try {
        fd = fs.openSync(file, 'r');
        const { size } = fs.fstatSync(fd);
        const headLen = Math.min(8192, size);
        const headBuf = Buffer.alloc(headLen);
        if (headLen > 0) fs.readSync(fd, headBuf, 0, headLen, 0);
        const tailLen = Math.min(65536, size);
        const tailBuf = Buffer.alloc(tailLen);
        if (tailLen > 0) fs.readSync(fd, tailBuf, 0, tailLen, size - tailLen);
        return {
            size,
            head: headBuf.toString('utf8'),
            tail: tailBuf.toString('utf8'),
        };
    } catch {
        return null;
    } finally {
        if (fd !== undefined) fs.closeSync(fd);
    }
}

// Read live vMix streaming bandwidth. Windows-only; returns supported:false
// elsewhere (e.g. the dev box). Runs on demand (no spawn, no sleep): reads each
// active log's tail and takes the last bitrate= value verbatim.
export default function getVmixBandwidth(): Promise<VmixBandwidth> {
    if (process.platform !== 'win32') {
        return Promise.resolve({ streams: [], supported: false });
    }
    try {
        const logs = newestLogs();
        const seen = new Set<string>();
        const streams: VmixStream[] = [];
        let hadAnyBaseline = false;

        logs.forEach(({ index, file }) => {
            seen.add(file);
            const parts = readParts(file);
            if (!parts) return;

            const prev = lastSize.get(file);
            if (prev !== undefined) hadAnyBaseline = true;
            lastSize.set(file, parts.size);
            // Active = grew since the previous poll. First poll has no baseline,
            // so a stream shows up one tick later - cheaper than sleeping.
            if (prev === undefined || parts.size <= prev) return;

            const cmd = (/^.*ffmpeg6\.exe.*$/im.exec(parts.head) || [''])[0];
            // Bitrate = the last bitrate= value in the log, verbatim (m -> kbps).
            const ms = [
                ...parts.tail.matchAll(/bitrate=\s*([\d.]+)(k|m)bits\/s/gi),
            ];
            let kbps: number | null = null;
            if (ms.length > 0) {
                const last = ms[ms.length - 1];
                kbps =
                    parseFloat(last[1]) *
                    (last[2].toLowerCase() === 'm' ? 1000 : 1);
            }

            streams.push({
                index,
                targetKbps: parseKbps(cmd, '-b:v'),
                maxrateKbps: parseKbps(cmd, '-maxrate:v'),
                liveKbps: kbps != null ? Math.max(0, kbps) : null,
                destination: labelDestination(cmd),
                rtmpUrl: rtmpUrl(cmd),
            });
        });

        // Forget logs that vanished so a new session starts clean.
        [...lastSize.keys()].forEach((k) => {
            if (!seen.has(k)) lastSize.delete(k);
        });

        streams.sort((a, b) => a.index - b.index);
        // Logs exist but we had no baseline for any of them: this is the first
        // poll of a fresh session, so we can't tell what's active yet.
        const warming = logs.length > 0 && !hadAnyBaseline;
        return Promise.resolve({ streams, supported: true, warming });
    } catch (e) {
        log.warn('vMix bandwidth read failed', e);
        return Promise.resolve({ streams: [], supported: true });
    }
}
