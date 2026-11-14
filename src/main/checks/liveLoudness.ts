import { ChildProcess, spawn } from 'child_process';
import log from 'electron-log';
import { ffmpegPath } from '../cutMatch';
import { parseEbur128Line } from './loudness';

// The stream's loudness live, for the level wizard: ffmpeg's ebur128 on
// vMix's own DirectShow audio device for Bus A ("vMix Audio - Bus A", the
// device vMix's streaming ffmpeg reads, see vmixBandwidth.ts). One 400 ms
// momentary loudness block (LUFS) and its frame true peak every 100 ms.
// Only while the wizard is open; nothing else records audio.
// Windows only (DirectShow). Not tried against a cart yet: whether a second
// reader of the vMix Audio device works next to the stream is unproven, so a
// failure to open it is "no stream measurement", never an error.

export const STREAM_DEVICE = 'vMix Audio - Bus A';

export type LiveBlock = { at: number; m: number; peak: number | null };

export default class LiveLoudness {
    private child: ChildProcess | null = null;

    private buf = '';

    // Last time a block arrived (0: none yet).
    public lastAt = 0;

    public failed: string | null = null;

    public onBlock: ((_b: LiveBlock) => void) | null = null;

    public get running() {
        return !!this.child;
    }

    public start() {
        if (this.child || process.platform !== 'win32') {
            if (process.platform !== 'win32') this.failed = 'Not Windows';
            return;
        }
        this.failed = null;
        const child = spawn(
            ffmpegPath(),
            [
                '-hide_banner',
                '-nostats',
                '-f',
                'dshow',
                '-audio_buffer_size',
                '50',
                '-i',
                `audio=${STREAM_DEVICE}`,
                '-af',
                'ebur128=peak=true',
                '-f',
                'null',
                '-',
            ],
            { windowsHide: true }
        );
        this.child = child;
        child.stderr?.on('data', (d) => this.onData(d.toString()));
        child.on('error', (e) => {
            log.warn('Live loudness: ffmpeg failed', e);
            this.failed = 'ffmpeg failed';
            this.child = null;
        });
        child.on('close', (code) => {
            if (this.child === child) {
                this.child = null;
                if (!this.failed && code) this.failed = 'No vMix audio';
            }
        });
    }

    public stop() {
        const c = this.child;
        this.child = null;
        try {
            c?.kill();
        } catch {
            // already gone
        }
    }

    // ffmpeg output arrives in chunks; whole lines only.
    public onData(text: string) {
        this.buf += text;
        const lines = this.buf.split(/\r?\n/);
        this.buf = lines.pop() ?? '';
        lines.forEach((line) => {
            const b = parseEbur128Line(line);
            // The first blocks cover less than 400 ms (ffmpeg pads them).
            if (!b || b.t < 0.399) return;
            this.lastAt = Date.now();
            this.onBlock?.({ at: this.lastAt, m: b.m, peak: b.peak });
        });
    }
}
