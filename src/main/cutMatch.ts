import { ChildProcess, spawn } from 'child_process';
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

// Every ffmpeg this process started that has not exited yet.
const running = new Set<ChildProcess>();

export function run(
    bin: string,
    args: string[]
): Promise<{ code: number | null; stderr: string }> {
    return new Promise((resolve, reject) => {
        const child = spawn(bin, args, { windowsHide: true });
        running.add(child);
        let stderr = '';
        child.stderr.on('data', (d) => {
            stderr += d.toString();
        });
        child.on('error', (err) => {
            running.delete(child);
            reject(err);
        });
        child.on('close', (code) => {
            running.delete(child);
            resolve({ code, stderr });
        });
    });
}

// Kill every ffmpeg still running, for a quit. A child outlives the app on
// Windows: at BGRC 2026 a restart mid-cut left Q11's ffmpeg writing its
// .cutting file, the new instance's recovery could not delete it (EBUSY), and
// the match sat in "processing" with no video in the event folder.
export function killRunningFfmpeg(): void {
    running.forEach((child) => {
        try {
            child.kill();
        } catch {
            // already gone
        }
    });
    running.clear();
}

// Read a file's duration (seconds) by parsing ffmpeg's own banner, so we don't
// depend on ffprobe being present next to ffmpeg6.exe.
export async function probeDuration(file: string): Promise<number | null> {
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
// recordings that never had dead time are just re-encoded whole. Returns the
// stretches of the source kept, in order (seconds), so the cut can be mapped
// back to the time it was recorded.
export default async function cutMatchVideo(
    source: string,
    outPath: string,
    opts: CutOptions = {}
): Promise<{ from: number; seconds: number }[]> {
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
    let kept: { from: number; seconds: number }[];
    if (dur <= matchKeep + resultsKeep) {
        // No dead time to cut; re-encode the whole thing.
        args = ['-y', '-v', 'error', '-i', source, ...enc, outPath];
        kept = [{ from: 0, seconds: dur }];
    } else {
        const startB = (dur - resultsKeep).toFixed(3);
        kept = [
            { from: 0, seconds: matchKeep },
            { from: dur - resultsKeep, seconds: resultsKeep },
        ];
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
    return kept;
}

// Wait until vMix has finished writing a recording. vMix writes the MP4
// index (moov atom) last, after its API already reports the recording
// stopped; a copy taken before that has no index and cannot be read. Done
// when ffmpeg can read the duration and the size has stopped changing.
// Returns false on timeout.
export async function waitForFinishedVideo(
    file: string,
    timeoutMs = 60000
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    let lastSize = -1;
    while (Date.now() < deadline) {
        let size = -1;
        try {
            size = fs.statSync(file).size;
        } catch {
            // not there yet
        }
        // eslint-disable-next-line no-await-in-loop
        if (size > 0 && size === lastSize && (await probeDuration(file))) {
            return true;
        }
        lastSize = size;
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve) => {
            setTimeout(resolve, 1000);
        });
    }
    return false;
}

// Move a finished recording, copying across drives. The source is only
// deleted once the copy reads as a video, so a bad copy never loses footage.
export async function moveVideo(source: string, target: string) {
    try {
        fs.renameSync(source, target);
        return;
    } catch (err) {
        if ((err as { code?: string }).code !== 'EXDEV') throw err;
    }
    // Async: a multi-GB copy must not block the main process (an FTC Match
    // Start arriving meanwhile would be timestamped late).
    await fs.promises.copyFile(source, target);
    if (!(await probeDuration(target))) {
        fs.unlinkSync(target);
        throw new Error(`Copy of ${source} does not read as a video`);
    }
    fs.unlinkSync(source);
}

// Join pieces of one or more files into one video: each piece is
// {file, from, seconds}, in order. Frame-accurate re-encode with the same
// settings as cutMatchVideo. Used for FTC, where a match's play and its score
// reveal can sit in different raw files.
export async function assembleClips(
    pieces: { file: string; from: number; seconds: number }[],
    outPath: string
): Promise<void> {
    const inputs: string[] = [];
    let fc = '';
    pieces.forEach((p, i) => {
        inputs.push(
            '-ss',
            p.from.toFixed(3),
            '-t',
            p.seconds.toFixed(3),
            '-i',
            p.file
        );
        fc += `[${i}:v]setpts=PTS-STARTPTS[v${i}];[${i}:a]asetpts=PTS-STARTPTS[a${i}];`;
    });
    fc += `${pieces.map((_, i) => `[v${i}][a${i}]`).join('')}concat=n=${
        pieces.length
    }:v=1:a=1[v][a]`;
    const args = [
        '-y',
        '-v',
        'error',
        ...inputs,
        '-filter_complex',
        fc,
        '-map',
        '[v]',
        '-map',
        '[a]',
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
        outPath,
    ];
    const { code, stderr } = await run(ffmpegPath(), args);
    if (code !== 0) {
        log.error('assembleClips ffmpeg failed', stderr);
        throw new Error(
            `ffmpeg exited ${code}: ${stderr
                .split('\n')
                .slice(-3)
                .join(' ')
                .trim()}`
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
