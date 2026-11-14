import {
    gatedLoudness,
    parseEbur128,
    talkLoudness,
    wallTime,
} from '../main/checks/loudness';
import { TalkLog } from '../main/checks/talking';

jest.mock('electron-log', () => ({ warn: jest.fn() }));
jest.mock('../main/recordings/matchStore', () => ({ updateMatch: jest.fn() }));

// ffmpeg's ebur128 output: a line per 100 ms, then the summary.
function ebur128(ms: number[], i: number) {
    const lines = ms.map(
        (m, k) =>
            `[Parsed_ebur128_0 @ 0x55] t: ${((k + 1) / 10).toFixed(
                6
            )}  TARGET:-23 LUFS    M:${m.toFixed(
                1
            )} S:-120.7     I: -70.0 LUFS       LRA:   0.0 LU  FTPK: -18.1 dBFS  TPK: -18.1 dBFS`
    );
    return `${lines.join('\n')}
[Parsed_ebur128_0 @ 0x55] Summary:

  Integrated loudness:
    I:         ${i.toFixed(1)} LUFS
    Threshold: -31.1 LUFS

  True peak:
    Peak:      -3.2 dBFS
`;
}

describe('loudness while talking', () => {
    it('reads the per-block loudness and the summary', () => {
        const r = parseEbur128(
            ebur128([-120.7, -120.7, -120.7, -20, -21], -20.5)
        );
        expect(r).toMatchObject({ lufs: -20.5, truePeak: -3.2 });
        expect(r!.blocks).toEqual([
            { t: 0.1, m: -120.7 },
            { t: 0.2, m: -120.7 },
            { t: 0.3, m: -120.7 },
            { t: 0.4, m: -20 },
            { t: 0.5, m: -21 },
        ]);
    });

    it('gates the BS.1770 way', () => {
        // Equal blocks are their own loudness.
        expect(gatedLoudness([-20, -20, -20])).toBeCloseTo(-20, 5);
        // Under -70 and more than 10 LU under the rest are left out.
        expect(gatedLoudness([-20, -20, -35, -80])).toBeCloseTo(-20, 5);
        // Energy mean, not the mean of the dB values.
        expect(gatedLoudness([-20, -23])).toBeCloseTo(-21.25, 2);
        expect(gatedLoudness([-80, -90])).toBeNull();
    });

    it('maps a cut video back to when it was recorded', () => {
        const T = 1_000_000;
        // Match kept 0..166 s, results the last 16 s of a 300 s recording.
        const segs = [
            { wallStart: T, seconds: 166 },
            { wallStart: T + 284_000, seconds: 16 },
        ];
        expect(wallTime(segs, 10)).toBe(T + 10_000);
        expect(wallTime(segs, 170)).toBe(T + 288_000);
        expect(wallTime(segs, 183)).toBeNull();
    });

    it('a silent stream with nobody talking has no verdict', () => {
        const T = 1_000_000;
        const log = new TalkLog();
        // Mics read every 50 ms for 20 s; nobody talks.
        for (let t = T; t <= T + 20_000; t += 50) log.note(t, false);
        const blocks = Array.from({ length: 200 }, (_, k) => ({
            t: (k + 1) / 10,
            m: -60,
        }));
        const r = talkLoudness(
            blocks,
            [{ wallStart: T, seconds: Infinity }],
            log
        );
        expect(r).toEqual({ heard: true, seconds: 0, lufs: null });
    });

    it('judges only the blocks someone talked in', () => {
        const T = 1_000_000;
        const log = new TalkLog();
        // Talking from 5 s to 10 s with 300 ms gaps between words, silent
        // otherwise; mics read the whole 20 s.
        for (let t = T; t <= T + 20_000; t += 50) {
            const s = (t - T) / 1000;
            const word = s >= 5 && s < 10 && (s * 1000) % 1000 < 700;
            log.note(t, word);
        }
        // The stream: -20 LUFS while talking, -45 between.
        const blocks = Array.from({ length: 200 }, (_, k) => {
            const t = (k + 1) / 10;
            return { t, m: t > 5.2 && t <= 10.6 ? -20 : -45 };
        });
        const r = talkLoudness(
            blocks,
            [{ wallStart: T, seconds: Infinity }],
            log
        );
        // 5 s of talking plus the 1 s hangover; the word gaps never end it.
        expect(log.talk).toHaveLength(1);
        expect(r.heard).toBe(true);
        expect(r.seconds).toBeGreaterThanOrEqual(5.5);
        expect(r.seconds).toBeLessThanOrEqual(6.5);
        expect(r.lufs).toBeCloseTo(-20, 1);
    });

    it('no mic levels for the time the video covers', () => {
        const log = new TalkLog();
        log.note(5_000_000, true);
        const r = talkLoudness(
            [{ t: 1, m: -20 }],
            [{ wallStart: 1_000_000, seconds: Infinity }],
            log
        );
        expect(r).toEqual({ heard: false, seconds: 0, lufs: null });
    });
});
