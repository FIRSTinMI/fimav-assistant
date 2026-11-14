// The vMix / X-Air tab's audio section and level wizard
// (src/main/checks/levelWizard.ts), shared with the UI.

export type LevelStep = 'red' | 'blue' | 'match' | 'dj' | 'stream' | 'check';

export const LEVEL_STEPS_ORDER: LevelStep[] = [
    'red',
    'blue',
    'match',
    'dj',
    'stream',
    'check',
];

export type LevelSourceId = 'red' | 'blue' | 'match' | 'dj';

export type LevelStepStatus =
    | 'listening'
    | 'done'
    | 'no signal'
    | 'no match'
    | 'match running';

export interface LevelRow {
    id: LevelSourceId;
    label: string;
    status: LevelStepStatus;
    // Energy mean of the input meter while it sounded, at the gain it has
    // now (dBFS, pre-fader),
    // and the level on Bus 1 out (as planned once there is a plan). No
    // Master value: the venue input decides how loud the room is, not LR.
    input: number | null;
    // Input gain now (preamp or trim), dB; null with none.
    gain: number | null;
    bus: number | null;
    // Predicted stream loudness after the plan (LUFS; meter dBFS when the
    // plan is an estimate).
    stream: number | null;
    sendLimited: 'max' | 'grp' | null;
}

export interface WizardState {
    step: LevelStep;
    steps: LevelStep[];
    // The step source's input meter now (dBFS, after its gain).
    input: number | null;
    // The on-screen control: what it moves ("Master", "Blue mic gain",
    // "Match sounds", "DJ gain"), a fader (fader law, off to +10 dB) or an
    // input gain (linear dB, its range and step), and its value.
    control: {
        label: string;
        kind: 'fader' | 'gain';
        db: number;
        minDb: number | null;
        maxDb: number | null;
        stepDb: number | null;
    } | null;
    matchRunning: string | null;
    // Mics and DJ with no gain the wizard can set (balanced on the fader).
    noGain: ('red' | 'blue' | 'dj')[];
    // The DJ step turned a DJ Bus 1 send off.
    djSendOff: boolean;
    // Mic / match-sound Bus 1 sends not post-fader (Apply switches them),
    // and the ones Apply switched.
    toPost: LevelSourceId[];
    madePost: LevelSourceId[];
    // The stream was loud while DJ played alone.
    djOnStream: boolean;
    rows: LevelRow[];
    plan: {
        busFrom: number;
        busTo: number;
        lufs: number;
        peak: number;
        estimate: boolean;
        limitedBy: 'peak' | 'max' | null;
    } | null;
    // vMix Bus A volume (100 = 0 dB), null when vMix did not say.
    busAVolume: number | null;
    // Live stream loudness (vMix Bus A, ffmpeg ebur128).
    stream: {
        running: boolean;
        failed: string | null;
        momentary: number | null;
    };
    verify: {
        from: 'live' | 'match' | null;
        lufs: number | null;
        peak: number | null;
        seconds: number;
        residual: number | null;
        // The stream loudness verdict on it (streamVerdict, the same as the
        // match-video check): a change of up to 5 dB is ok.
        state: 'ok' | 'warning' | null;
    };
    applied: boolean;
    undo: number;
    busy: boolean;
    error: string | null;
}

export interface LevelState {
    mixer: boolean;
    streamBus: number;
    // X-Air main LR out (information only, never judged) and stream bus out
    // (with its master fader), dBFS.
    masterOut: number | null;
    streamOut: number | null;
    wizard: WizardState | null;
}
