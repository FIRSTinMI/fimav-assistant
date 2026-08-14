import { spawn } from 'child_process';
import fs from 'fs';
import log from 'electron-log';

// vMix ships an ffmpeg it already uses for streaming; reuse it so we don't have
// to bundle our own. Fall back to an ffmpeg on PATH for the dev box.
const VMIX_FFMPEG = 'C:\\Program Files (x86)\\vMix\\streaming\\ffmpeg6.exe';

export function ffmpegPath(): string {
    try {
        if (fs.existsSync(VMIX_FFMPEG)) return VMIX_FFMPEG;
    } catch {
        // ignore
    }
    return 'ffmpeg';
}

function run(
    bin: string,
    args: string[]
): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true });
        let stderr = '';
        child.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('error', reject);
        child.on('close', (code) => resolve({ code, stderr }));
    });
}

// Read a file's duration (seconds) by parsing ffmpeg's own banner, so we don't
// depend on ffprobe being present next to ffmpeg6.exe.
async function probeDuration(file: string): Promise<number | null> {
    const { stderr } = await run(ffmpegPath(), ['-i', file]);
    const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
    if (!m) return null;
    return (
        parseInt(m[1], 10) * 3600 +
        parseInt(m[2], 10) * 60 +
        parseFloat(m[3])
    );
}

export interface CutOptions {
    matchKeep?: number; // seconds from start to keep (default 166)
    resultsKeep?: number; // seconds from the end to keep (default 16)
}

// Cut the dead time out of a raw match recording: keep [0 -> matchKeep] (the
// match + a few seconds after the buzzer) and [last resultsKeep] (the winner
// animation + results screen), stitched with a frame-accurate re-encode. This
// mirrors the standalone cut-matches script (libx264 CRF20 + AAC 192k). Short
// recordings that never had dead time are just re-encoded whole.
export default async function cutMatchVideo(
    source: string,
    outPath: string,
    opts: CutOptions = {}
): Promise<void> {
    const matchKeep = opts.matchKeep ?? 166;
    const resultsKeep = opts.resultsKeep ?? 16;

    if (!fs.existsSync(source)) {
        throw new Error(`Source not found: ${source}`);
    }

    const dur = await probeDuration(source);
    if (dur == null) {
        throw new Error('Could not read the recording duration');
    }

    const enc = [
        '-c:v',
        'libx264',
        '-crf',
        '20',
        '-preset',
        'medium',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '192k',
    ];

    let args: string[];
    if (dur <= matchKeep + resultsKeep) {
        // No dead time to cut; re-encode the whole thing.
        args = ['-y', '-v', 'error', '-i', source, ...enc, outPath];
    } else {
        const startB = (dur - resultsKeep).toFixed(3);
        const fc =
            `[0:v]trim=0:${matchKeep},setpts=PTS-STARTPTS[v0];` +
            `[0:a]atrim=0:${matchKeep},asetpts=PTS-STARTPTS[a0];` +
            `[0:v]trim=${startB},setpts=PTS-STARTPTS[v1];` +
            `[0:a]atrim=${startB},asetpts=PTS-STARTPTS[a1];` +
            `[v0][a0][v1][a1]concat=n=2:v=1:a=1[v][a]`;
        args = [
            '-y',
            '-v',
            'error',
            '-i',
            source,
            '-filter_complex',
            fc,
            '-map',
            '[v]',
            '-map',
            '[a]',
            ...enc,
            outPath,
        ];
    }

    const { code, stderr } = await run(ffmpegPath(), args);
    if (code !== 0) {
        log.error('cutMatchVideo ffmpeg failed', stderr);
        throw new Error(
            `ffmpeg exited ${code}: ${stderr.split('\n').slice(-3).join(' ').trim()}`
        );
    }
    if (!fs.existsSync(outPath)) {
        throw new Error('ffmpeg reported success but produced no output file');
    }
}

// Serialize cuts so a burst of matches doesn't spin up several parallel
// re-encodes and starve vMix/streaming of CPU. Each task runs after the last.
let queue: Promise<void> = Promise.resolve();

export function enqueueCut(task: () => Promise<void>): Promise<void> {
    queue = queue.then(task, task);
    return queue;
}
