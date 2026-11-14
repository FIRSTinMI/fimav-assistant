import {
    dbToLevel,
    FADER_STEPS,
    gainToLevel,
    LEVEL_STEPS,
    levelToDb,
    levelToGain,
    channelGain,
    gainDbToLevel,
    gainLevelToDb,
    gainStepDb,
    preampGain,
} from '../utils/xairLaw';
import {
    busLevel,
    Measured,
    planStreamMix,
    residual,
    SourceMeter,
    SourceMix,
    stepStatus,
    StreamMeter,
} from '../main/checks/levels';
import {
    levelChange,
    parseEbur128Line,
    streamVerdict,
} from '../main/checks/loudness';

jest.mock('electron-log', () => ({ warn: jest.fn(), info: jest.fn() }));
jest.mock('../main/recordings/matchStore', () => ({ updateMatch: jest.fn() }));

describe('X-Air fader law', () => {
    it('matches the documented points', () => {
        // Parameters.txt / Maillot: 0.75 = 0 dB, 1.0 = +10, and the knees.
        expect(levelToDb(1)).toBeCloseTo(10, 6);
        expect(levelToDb(0.75)).toBeCloseTo(0, 6);
        expect(levelToDb(0.5)).toBeCloseTo(-10, 6);
        expect(levelToDb(0.25)).toBeCloseTo(-30, 6);
        expect(levelToDb(0.0625)).toBeCloseTo(-60, 6);
        expect(levelToDb(0)).toBe(-Infinity);
    });

    it('matches the 161-step level table', () => {
        // Maillot, "Level Table - 161 pseudo-log scale Level values".
        const table: [number, number][] = [
            [0.0063, -87],
            [0.2688, -28.5],
            [0.5375, -8.5],
            [0.8062, 2.3],
            [0.3812, -19.5],
            [0.9375, 7.5],
        ];
        table.forEach(([f, db]) => {
            expect(levelToDb(dbToLevel(db, LEVEL_STEPS))).toBeCloseTo(db, 0);
            expect(dbToLevel(db, LEVEL_STEPS)).toBeCloseTo(f, 3);
        });
    });

    it('round-trips every fader and send step exactly', () => {
        [FADER_STEPS, LEVEL_STEPS].forEach((steps) => {
            for (let i = 1; i < steps; i += 1) {
                const f = i / (steps - 1);
                expect(dbToLevel(levelToDb(f), steps)).toBe(f);
            }
        });
    });

    it('rounds to the nearest step and stops at +10 dB and off', () => {
        // 0 dB is not a fader step: the nearest is 767/1023 (-0.01 dB).
        expect(dbToLevel(0, FADER_STEPS)).toBe(767 / 1023);
        expect(levelToDb(dbToLevel(0, FADER_STEPS))).toBeCloseTo(-0.01, 2);
        expect(dbToLevel(25, FADER_STEPS)).toBe(1);
        expect(dbToLevel(-Infinity, FADER_STEPS)).toBe(0);
        expect(dbToLevel(-95, LEVEL_STEPS)).toBe(0);
        expect(levelToDb(dbToLevel(-50, FADER_STEPS))).toBeCloseTo(-50, 1);
    });

    it('preamp gain is linear -12..+60 dB in 145 steps', () => {
        expect(gainToLevel(20)).toBe(64 / 144);
        expect(levelToGain(gainToLevel(20))).toBeCloseTo(20, 6);
        expect(gainToLevel(-30)).toBe(0);
        expect(gainToLevel(99)).toBe(1);
    });
});

describe('input gain controls', () => {
    it("a channel's gain: its preamp, or its USB return trim, or none", () => {
        expect(channelGain('/ch/02', 1, 0)?.address).toBe('/headamp/02/gain');
        expect(channelGain('/ch/05', 11, 0)?.address).toBe('/headamp/12/gain');
        expect(channelGain('/ch/03', 2, 1)).toMatchObject({
            address: '/ch/03/preamp/rtntrim',
            minDb: -18,
            maxDb: 18,
            refDb: 0,
        });
        // Aux L/R or off as the input: no preamp.
        expect(channelGain('/ch/01', 16, 0)).toBeNull();
        expect(channelGain('/ch/01', 18, 0)).toBeNull();
    });

    it('preamp gain: -12..+60 dB in 0.5 dB steps, reference +20', () => {
        const g = preampGain(1);
        expect(gainStepDb(g)).toBe(0.5);
        expect(g.refDb).toBe(20);
        expect(gainLevelToDb(gainDbToLevel(31.5, g), g)).toBeCloseTo(31.5, 9);
        expect(gainLevelToDb(gainDbToLevel(31.3, g), g)).toBeCloseTo(31.5, 9);
        expect(gainDbToLevel(80, g)).toBe(1);
        expect(gainDbToLevel(-30, g)).toBe(0);
    });
});

describe('ebur128 line and the change to -14 LUFS', () => {
    it('reads the momentary loudness and the frame true peak', () => {
        const line =
            '[Parsed_ebur128_0 @ 0x55] t: 1.2  TARGET:-23 LUFS    M: -18.4 S: -19.0     I: -20.0 LUFS       LRA:   0.0 LU  FTPK: -6.1 -4.9 dBFS  TPK: -4.9 -4.9 dBFS';
        expect(parseEbur128Line(line)).toEqual({
            t: 1.2,
            m: -18.4,
            peak: -4.9,
        });
        expect(parseEbur128Line('Stream mapping:')).toBeNull();
    });

    it('is the stream loudness check maths', () => {
        // Boost, capped at the headroom under -1 dBTP.
        expect(levelChange(-20, -10)).toEqual({ db: 6, peaking: false });
        expect(levelChange(-20, -3)).toEqual({ db: 2, peaking: false });
        // Cut to the target.
        expect(levelChange(-10, -5)).toEqual({ db: -4, peaking: false });
        // Peaking: the bigger of the peak cut and the loudness cut.
        expect(levelChange(-16, 0.5)).toEqual({ db: -1.5, peaking: true });
        expect(levelChange(null, null)).toEqual({ db: null, peaking: false });
    });

    it('the verdict is on the change shown, after the headroom cap', () => {
        // BGRC Q27: -20.0 LUFS, peak -3.9 dBTP: +2.9 dB, no warning.
        expect(streamVerdict(-20, -3.9)).toEqual({
            state: 'ok',
            db: 2.9,
            peaking: false,
        });
        expect(streamVerdict(-25, -10)?.state).toBe('warning');
        expect(streamVerdict(-9, -2)?.state).toBe('ok');
        expect(streamVerdict(-8.9, -2)?.state).toBe('warning');
        // Peaking is a warning whatever the size.
        expect(streamVerdict(-14, -0.5)).toEqual({
            state: 'warning',
            db: -0.5,
            peaking: true,
        });
        expect(streamVerdict(null, null)).toBeNull();
    });

    it('no cap on the residual, only the peak limit', () => {
        expect(residual(-20, -10)).toBe(6);
        expect(residual(-30, -20)).toBe(16);
        expect(residual(-40, -45)).toBe(26);
        expect(residual(-2, -3)).toBe(-12);
        // Headroom under -1 dBTP is the physical limit.
        expect(residual(-30, -6)).toBe(5);
        expect(residual(null, null)).toBeNull();
    });
});

describe('metering a step', () => {
    it('counts only readings over the gate, as an energy mean', () => {
        const m = new SourceMeter();
        let t = 0;
        // 2 s of -60 (silence), then 3 s alternating -20 and -23.
        for (; t < 2000; t += 50) m.feed(t, -60);
        expect(m.inputDb).toBeNull();
        for (let k = 0; t < 5000; t += 50, k += 1) m.feed(t, k % 2 ? -23 : -20);
        expect(m.seconds).toBeCloseTo(3, 1);
        expect(m.inputDb).toBeCloseTo(-21.25, 1);
        expect(m.peakDb).toBe(-20);
    });

    it('does not count a long gap between packets as sounding', () => {
        const m = new SourceMeter();
        m.feed(0, -20);
        m.feed(5000, -20);
        expect(m.seconds).toBeCloseTo(0.2, 5);
    });

    it('mic steps: listening, done, no signal', () => {
        const none = { running: false, seen: false };
        const t0 = 1_000_000;
        expect(
            stepStatus(
                'red',
                { seconds: 2, lastHeardAt: t0 },
                t0 + 1000,
                t0,
                none
            )
        ).toBe('listening');
        expect(
            stepStatus(
                'red',
                { seconds: 5, lastHeardAt: t0 },
                t0 + 1000,
                t0,
                none
            )
        ).toBe('done');
        expect(
            stepStatus(
                'blue',
                { seconds: 0, lastHeardAt: null },
                t0 + 9000,
                t0,
                none
            )
        ).toBe('no signal');
        expect(
            stepStatus(
                'blue',
                { seconds: 0, lastHeardAt: null },
                t0 + 3000,
                t0,
                none
            )
        ).toBe('listening');
    });

    it('match step: waits for a match, listens, then done or no signal', () => {
        const m = { seconds: 0, lastHeardAt: null };
        expect(
            stepStatus('match', m, 0, 0, { running: false, seen: false })
        ).toBe('no match');
        expect(
            stepStatus('match', m, 0, 0, { running: true, seen: true })
        ).toBe('match running');
        expect(
            stepStatus('match', m, 0, 0, { running: false, seen: true })
        ).toBe('no signal');
        expect(
            stepStatus('match', { seconds: 4, lastHeardAt: 0 }, 0, 0, {
                running: false,
                seen: true,
            })
        ).toBe('done');
    });

    it('stream blocks are gated the BS.1770 way', () => {
        const s = new StreamMeter();
        [-20, -20, -80, -20].forEach((m) => s.add(m, -6));
        expect(s.lufs).toBeCloseTo(-20, 5);
        expect(s.seconds).toBeCloseTo(0.4, 5);
        expect(s.peak).toBe(-6);
    });
});

const meas = (
    id: Measured['id'],
    inputDb: number,
    peakDb = inputDb + 10,
    over: Partial<Measured> = {}
): Measured => ({
    id,
    inputDb,
    peakDb,
    streamLufs: null,
    meterBusDb: null,
    ...over,
});

const mix = (
    id: SourceMix['id'],
    over: Partial<SourceMix> = {}
): SourceMix => ({
    id,
    faderDb: 0,
    sendDb: 0,
    tap: 3,
    usable: true,
    ...over,
});

describe('a post-fader send', () => {
    it('follows the channel fader on Bus 1 dB for dB', () => {
        const at = (faderDb: number) =>
            busLevel(-20, mix('red', { tap: 4, faderDb, sendDb: -3 }));
        expect(at(-6) - at(0)).toBe(-6);
        expect(at(4) - at(0)).toBe(4);
        // A pre-fader one does not.
        expect(busLevel(-20, mix('red', { tap: 3, faderDb: -6 }))).toBe(-20);
    });
});

describe('stream mix plan', () => {
    it('makes every source equal on Bus 1, then the stream -14 LUFS', () => {
        const p = planStreamMix(
            [meas('red', -20), meas('blue', -26), meas('match', -14)],
            [mix('red'), mix('blue'), mix('match')],
            0
        )!;
        const send = (id: string) => p.sends.find((s) => s.id === id)!.toDb;
        expect(send('red')).toBeCloseTo(0, 1);
        expect(send('blue')).toBeCloseTo(6, 1);
        expect(send('match')).toBeCloseTo(-6, 1);
        p.predicted.forEach((x) => expect(x.lufs).toBeCloseTo(-14, 1));
        expect(p.lufs).toBeCloseTo(-14, 1);
        expect(p.bus.toDb).toBeCloseTo(6, 1);
        expect(p.peakDb).toBeLessThanOrEqual(-1);
        expect(p.estimate).toBe(true);
        expect(p.limitedBy).toBeNull();
    });

    it('stops at the peak limit', () => {
        const p = planStreamMix(
            [meas('red', -20, -2), meas('blue', -20, -12)],
            [mix('red'), mix('blue')],
            0
        )!;
        expect(p.peakDb).toBeLessThanOrEqual(-1);
        expect(p.peakDb).toBeGreaterThan(-1.2);
        expect(p.lufs).toBeLessThan(-14);
        expect(p.limitedBy).toBe('peak');
    });

    it('counts the channel fader on a post-fader send', () => {
        const p = planStreamMix(
            [meas('red', -20), meas('blue', -20), meas('match', -20)],
            [mix('red', { faderDb: -10, tap: 4 }), mix('blue'), mix('match')],
            0
        )!;
        const m = [
            mix('red', { faderDb: -10, tap: 4 }),
            mix('blue'),
            mix('match'),
        ];
        const levels = p.sends.map((s, k) =>
            busLevel(-20, { ...m[k], sendDb: s.toDb })
        );
        levels.forEach((l) => expect(l).toBeCloseTo(levels[0], 0));
        // The post-fader one is sent 10 dB hotter than the others.
        expect(p.sends[0].toDb - p.sends[1].toDb).toBeCloseTo(10, 0);
    });

    it('pulls every send down together when one would pass +10 dB', () => {
        const p = planStreamMix(
            [meas('red', -10), meas('blue', -45), meas('match', -10)],
            [mix('red'), mix('blue'), mix('match')],
            0
        )!;
        const send = (id: string) => p.sends.find((s) => s.id === id)!.toDb;
        expect(send('blue')).toBeCloseTo(10, 1);
        expect(send('red')).toBeCloseTo(-25, 0);
        expect(p.sends.every((s) => s.limited === null)).toBe(true);
    });

    it('uses the measured stream LUFS to turn meter dBFS into LUFS', () => {
        const p = planStreamMix(
            [
                meas('red', -20, -10, { streamLufs: -22, meterBusDb: -20 }),
                meas('blue', -20, -10, { streamLufs: -22, meterBusDb: -20 }),
            ],
            [mix('red'), mix('blue')],
            0
        )!;
        expect(p.estimate).toBe(false);
        expect(p.lufs).toBeCloseTo(-14, 1);
        expect(p.bus.toDb).toBeCloseTo(8, 1);
    });

    it('a GRP-tapped source is the reference (its send does nothing)', () => {
        const p = planStreamMix(
            [meas('red', -20), meas('blue', -30)],
            [mix('red', { tap: 5, faderDb: -5 }), mix('blue')],
            0
        )!;
        expect(p.sends[0].toDb).toBe(0);
        // Blue to the GRP source's -25 dB.
        expect(
            busLevel(-30, { ...mix('blue'), sendDb: p.sends[1].toDb })
        ).toBeCloseTo(-25, 0);
    });

    it('leaves out a muted source and plans nothing without one', () => {
        expect(
            planStreamMix(
                [meas('red', -20)],
                [mix('red', { usable: false })],
                0
            )
        ).toBeNull();
        expect(planStreamMix([], [], 0)).toBeNull();
    });
});
