import fs from 'fs';
import path from 'path';
import log from 'electron-log';
import VmixService from '../../services/VmixService';
import Event from '../../models/Event';
import { TournamentLevel } from '../../models/FMSMatchState';
import { MatchRecord } from '../../models/MatchRecord';
import { FtcUpdate } from '../../models/Ftc';
import { matchFileName } from '../../utils/recording';
import { upsertMatch, updateMatch, getMatch } from '../recordings/matchStore';
import {
    assembleClips,
    enqueueCut,
    moveVideo,
    probeDuration,
    waitForFinishedVideo,
} from '../cutMatch';
import { getStore } from '../store';
import { queueLoudness, WallSegment } from '../checks/loudness';

// FTC match recording. Every match video is the match itself plus its score
// reveal, with the dead time between cut out. In-season and off-season are the
// same.
//
// vMix records "raw" files and this logs, against the wall clock, when each
// match started and when FTC Live posted its scores. A match's video is then
// cut out of whichever raw files cover two windows:
//
//   play    Match Start - 1 s  ->  Match Start + match length + tail
//   reveal  MATCH_POST         ->  MATCH_POST + 16 s
//
// Recording runs while anything still needs it: a match in play or waiting for
// its scores (up to RECORD_WAIT_MS), or an open reveal or abort window. So in
// the usual order (scores posted before the next match) each match gets its own
// raw file. When the next match starts first, the same raw file keeps running
// and the late reveal is cut out of it, wherever it lands; nothing is stopped
// in the middle of a match. A post that comes while nothing is recording starts
// a recording just for the reveal; a match waits GIVE_UP_MS for its scores.
//
// Raw files are moved into "<event folder>/Originals" and the timeline is saved
// next to them (ftc-timeline.json), so a restart can still finish matches whose
// footage is complete. A match's manifest record holds the upload (processing
// "queued") until its video is final.
//
// An aborted match keeps its raw footage in Originals but gets no video of its
// own: FTC Live replays it under the same name, and the replay is the match.

const LEAD_SECONDS = 1;
const REVEAL_SECONDS = 16;
const ABORT_KEEP_SECONDS = 10;
// How long recording runs on after a match while its scores are not posted.
// A later post still gets its reveal: it starts a recording just for it.
const RECORD_WAIT_MS = 10 * 60 * 1000;
// How long a finished match waits for its scores (its upload held) before
// its video is made without a reveal.
const GIVE_UP_MS = 30 * 60 * 1000;

interface RawFile {
    // vMix's file while recording; the Originals copy once stopped.
    path: string | null;
    start: number; // epoch ms
    end: number | null; // epoch ms, null while recording
    // False from the stop until vMix has finished the file and it is in
    // Originals. Absent in timelines from before this field: ready.
    ready?: boolean;
}

interface FtcRun {
    id: string; // manifest record id
    shortName: string;
    number: number;
    field: number;
    level: TournamentLevel;
    start: number; // epoch ms
    playEnd: number; // epoch ms
    post: number | null;
    abortAt: number | null;
    gaveUp: boolean;
    done: boolean;
}

interface Timeline {
    folder: string;
    raws: RawFile[];
    runs: FtcRun[];
}

export interface FtcRecorderHost {
    event(): Event | null;
    // The event folder recordings are filed into, or null when unknown.
    folder(): string | null;
    log(_message: string): void;
    setRecording(_on: boolean): void;
    record(_rec: MatchRecord): void;
}

const logger = log.scope('ftc.recorder');

function levelFor(shortName: string): TournamentLevel {
    // Practice, qualification and test short names start P / Q / T;
    // anything else is a playoff match. A test match ("T-2") falling
    // through to Playoff by default mislabeled it in the status display
    // (Filip, 2026-11-14, live at Chelsea Qualifier) - the recorded file
    // itself was unaffected, since the in-season filename builder uses the
    // FTC ShortName directly and never reaches this Level at all.
    if (/^Q/i.test(shortName)) return 'Qualification';
    if (/^P(R)?[-\d]/i.test(shortName)) return 'Practice';
    if (/^T[-\d]/i.test(shortName)) return 'Match Test';
    return 'Playoff';
}

export default class FtcRecorder {
    private host: FtcRecorderHost;

    private tl: Timeline | null = null;

    private recording = false;

    private timer: ReturnType<typeof setTimeout> | null = null;

    // Every vMix start/stop and timeline change runs in order on this chain,
    // so a stop and the next match's start never interleave.
    private chain: Promise<void> = Promise.resolve();

    constructor(host: FtcRecorderHost) {
        this.host = host;
    }

    private run(task: () => Promise<void>) {
        this.chain = this.chain.then(task).catch((e) => {
            logger.error('FTC recorder step failed', e);
            this.host.log(`FTC recorder error: ${e?.message ?? e}`);
        });
        return this.chain;
    }

    public onUpdate(u: FtcUpdate) {
        const now = Date.now();
        if (u.type === 'MATCH_START') this.run(() => this.onStart(u, now));
        else if (u.type === 'MATCH_POST') this.run(() => this.onPost(u, now));
        else if (u.type === 'MATCH_ABORT') this.run(() => this.onAbort(u, now));
    }

    // #region timeline

    // eslint-disable-next-line class-methods-use-this
    private timelinePath(folder: string) {
        return path.join(folder, 'Originals', 'ftc-timeline.json');
    }

    // The timeline for the current event folder, loaded from disk the first
    // time a folder is seen (finishing what a previous run left).
    private async timeline(): Promise<Timeline | null> {
        // Stay on the current folder while it has work in progress: the
        // folder the app shows can change mid-match (vMix reports its real
        // recording folder once recording starts, or the event name is
        // edited), and a switch then would orphan the open raw file and
        // leave records waiting forever in the old manifest.
        if (this.tl && this.busy()) return this.tl;
        const folder = this.host.folder();
        if (!folder) return null;
        if (this.tl?.folder === folder) return this.tl;
        let loaded: Timeline = { folder, raws: [], runs: [] };
        try {
            const p = this.timelinePath(folder);
            if (fs.existsSync(p)) {
                loaded = { ...JSON.parse(fs.readFileSync(p, 'utf8')), folder };
            }
        } catch (e) {
            logger.warn('Could not read the FTC timeline', e);
        }
        this.tl = loaded;
        await this.recover();
        return this.tl;
    }

    // Recording, a raw file not yet in Originals, or a match not finished.
    private busy(): boolean {
        const { tl } = this;
        if (!tl) return false;
        return (
            this.recording ||
            tl.raws.some((r) => r.end === null || r.ready === false) ||
            tl.runs.some((r) => !r.done)
        );
    }

    // Pick up where a previous run left off (FIM-AV restarted mid-event):
    // load the timeline, finish what can be finished, and arm the timers.
    public resume() {
        this.run(async () => {
            await this.timeline();
            await this.tick();
        });
    }

    private save() {
        if (!this.tl) return;
        try {
            const dir = path.join(this.tl.folder, 'Originals');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            const p = this.timelinePath(this.tl.folder);
            fs.writeFileSync(`${p}.tmp`, JSON.stringify(this.tl, null, 2));
            fs.renameSync(`${p}.tmp`, p);
        } catch (e) {
            logger.warn('Could not save the FTC timeline', e);
        }
    }

    // After a restart: a raw file left open was cut off when the app stopped,
    // so close it at its real length.
    private async recover() {
        const { tl } = this;
        if (!tl) return;
        let changed = false;
        // A file moved into Originals just before the restart, with the save
        // of its new path lost.
        tl.raws.forEach((raw) => {
            if (raw.path && !fs.existsSync(raw.path)) {
                const moved = path.join(
                    tl.folder,
                    'Originals',
                    `raw ${path.basename(raw.path)}`
                );
                if (fs.existsSync(moved)) {
                    raw.path = moved;
                    changed = true;
                }
            }
        });
        // eslint-disable-next-line no-restricted-syntax
        for (const raw of tl.raws) {
            if (raw.end === null && !this.recording) {
                // vMix kept recording through the restart: carry on with it.
                // eslint-disable-next-line no-await-in-loop
                const still = await VmixService.Instance.isRecording().catch(
                    () => false
                );
                const current = still
                    ? // eslint-disable-next-line no-await-in-loop
                      await VmixService.Instance.GetCurrentRecording().catch(
                          () => null
                      )
                    : null;
                if (still && current && current === raw.path) {
                    this.recording = true;
                    this.host.setRecording(true);
                } else {
                    // Closed at its real length; the file's last write when
                    // it cannot be read.
                    // eslint-disable-next-line no-await-in-loop
                    const dur = raw.path ? await probeDuration(raw.path) : null;
                    let end = raw.start + (dur ?? 0) * 1000;
                    if (!dur && raw.path && fs.existsSync(raw.path)) {
                        end = fs.statSync(raw.path).mtimeMs;
                    }
                    raw.end = end;
                }
                changed = true;
            }
        }
        // A move cut short by the restart: use the file where it is.
        tl.raws.forEach((raw) => {
            if (raw.end !== null && raw.ready === false) {
                raw.ready = true;
                changed = true;
            }
        });
        // Matches still waiting for scores keep waiting: FTC Live can still
        // post them, and tick gives up on them at GIVE_UP_MS.
        if (changed) this.save();
        this.finishReady();
    }

    // #endregion

    // #region events

    private async onStart(u: FtcUpdate, now: number) {
        const tl = await this.timeline();
        if (!tl) {
            this.host.log('No event folder; FTC match not recorded');
            return;
        }
        const store = getStore();
        const seconds =
            store.get('ftc.matchSeconds', 158) +
            store.get('ftc.tailSeconds', 5);
        const shortName = u.shortName || `Match ${u.number}`;
        const run: FtcRun = {
            id: `ftc_${shortName}_${now}`,
            shortName,
            number: u.number,
            field: u.field,
            level: levelFor(u.shortName),
            start: now,
            playEnd: now + seconds * 1000,
            post: null,
            abortAt: null,
            gaveUp: false,
            done: false,
        };
        tl.runs.push(run);
        this.save();

        const event = this.host.event();
        const rec: MatchRecord = {
            id: run.id,
            level: run.level,
            matchNumber: run.number,
            playNumber: 1,
            eventName: event?.name ?? 'Unknown Event',
            eventCode: event?.code ?? null,
            fileName: null,
            filePath: null,
            saveFolder: tl.folder,
            startedAt: now,
            endedAt: null,
            status: 'recording',
            ftc: { shortName, field: run.field },
        };
        upsertMatch(tl.folder, rec);
        this.host.record(rec);
        this.host.log(`Recording ${shortName} (field ${run.field})`);

        await this.ensureRecording(now);
        this.schedule();
    }

    private async onPost(u: FtcUpdate, now: number) {
        const tl = await this.timeline();
        if (!tl) return;
        // FTC Live's own spec (ApiV2UpdateMatchResultsPayload) only requires
        // number, field, redScore and blueScore on a post - shortName is
        // optional there (unlike on the start payload) and evidently comes
        // through empty for at least a test match (Filip, 2026-11-14, live
        // at Chelsea Qualifier: "T-2"'s post matched no run, so nothing ever
        // told the recorder its scores were in, and it ran until the wait
        // timer - he had to stop it by hand). number+field are guaranteed,
        // so they are the real match key; shortName (when present) only
        // disambiguates two pending runs that happen to share both.
        const pending = [...tl.runs]
            .reverse()
            .filter((r) => r.post === null && r.abortAt === null && !r.done);
        const byNumberField = pending.filter(
            (r) => r.number === u.number && r.field === u.field
        );
        const run =
            (u.shortName &&
                byNumberField.find((r) => r.shortName === u.shortName)) ||
            byNumberField[0] ||
            (u.shortName && pending.find((r) => r.shortName === u.shortName));
        if (!run) {
            this.host.log(
                `Scores posted for match ${u.number} field ${u.field}${
                    u.shortName ? ` ("${u.shortName}")` : ''
                } matched no pending run (pending: ${
                    pending.map((r) => r.shortName).join(', ') || 'none'
                })`
            );
            return;
        }
        run.post = Math.max(now, run.playEnd - LEAD_SECONDS * 1000);
        run.gaveUp = false;
        this.save();
        if (u.redScore !== undefined && u.blueScore !== undefined) {
            const rec = getMatch(tl.folder, run.id);
            if (rec) {
                updateMatch(tl.folder, run.id, {
                    score: { red: u.redScore, blue: u.blueScore },
                });
            }
        }
        this.host.log(`Scores posted for ${run.shortName}`);
        await this.ensureRecording(now);
        this.schedule();
    }

    private async onAbort(u: FtcUpdate, now: number) {
        const tl = await this.timeline();
        if (!tl) return;
        const run = [...tl.runs]
            .reverse()
            .find(
                (r) =>
                    r.shortName === (u.shortName || `Match ${u.number}`) &&
                    r.abortAt === null &&
                    !r.done
            );
        if (!run) return;
        run.abortAt = now;
        this.save();
        this.host.log(`${run.shortName} aborted`);
        this.schedule();
    }

    // #endregion

    // #region recording control

    // Whether anything still needs vMix to record at this moment.
    private needed(now: number): boolean {
        const { tl } = this;
        if (!tl) return false;
        return tl.runs.some((r) => {
            if (r.done) return false;
            if (r.abortAt !== null)
                return now < r.abortAt + ABORT_KEEP_SECONDS * 1000;
            if (r.post !== null) return now < r.post + REVEAL_SECONDS * 1000;
            if (r.gaveUp) return false;
            // In play, or finished and waiting for its scores.
            return now < r.playEnd + RECORD_WAIT_MS;
        });
    }

    // The next moment `needed` can change on its own.
    private nextDeadline(now: number): number | null {
        const { tl } = this;
        if (!tl) return null;
        const times: number[] = [];
        tl.runs.forEach((r) => {
            if (r.done) return;
            if (r.abortAt !== null)
                times.push(r.abortAt + ABORT_KEEP_SECONDS * 1000);
            else if (r.post !== null)
                times.push(r.post + REVEAL_SECONDS * 1000);
            else if (!r.gaveUp) {
                times.push(r.playEnd);
                times.push(r.playEnd + RECORD_WAIT_MS);
                times.push(r.playEnd + GIVE_UP_MS);
            }
        });
        const future = times.filter((t) => t > now);
        return future.length ? Math.min(...future) : null;
    }

    // Re-check now, and again at the next deadline.
    private schedule() {
        this.run(() => this.tick());
    }

    private arm() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        const now = Date.now();
        let next = this.nextDeadline(now);
        // Recording needed but not running (vMix refused): try again soon.
        if (!this.recording && this.needed(now)) {
            next = Math.min(next ?? Infinity, now + 5000);
        }
        if (next !== null) {
            this.timer = setTimeout(
                () => this.run(() => this.tick()),
                next - now + 50
            );
        }
    }

    private async tick() {
        const { tl } = this;
        if (!tl) return;
        const now = Date.now();
        let changed = false;
        tl.runs.forEach((r) => {
            if (
                !r.done &&
                r.post === null &&
                r.abortAt === null &&
                !r.gaveUp &&
                now >= r.playEnd + GIVE_UP_MS
            ) {
                r.gaveUp = true;
                changed = true;
                this.host.log(`No scores posted for ${r.shortName}`);
            }
            // Play over: the record leaves "recording" and holds the upload
            // until its video is made.
            if (!r.done && now >= r.playEnd) this.markWaiting(r);
        });
        if (changed) this.save();
        try {
            if (this.recording && !this.needed(now)) await this.stopRecording();
            // A start that failed (vMix down at Match Start) is retried here.
            await this.ensureRecording(now).catch((e) =>
                logger.warn('vMix did not start recording', e)
            );
        } finally {
            this.finishReady();
            this.arm();
        }
    }

    private markWaiting(r: FtcRun) {
        const folder = this.tl?.folder;
        if (!folder) return;
        const rec = getMatch(folder, r.id);
        if (!rec || rec.status !== 'recording') return;
        const updated = updateMatch(folder, r.id, {
            status: 'recorded',
            endedAt: r.playEnd,
            processing: { state: 'queued' },
        });
        if (updated) this.host.record(updated);
    }

    private async ensureRecording(now: number) {
        if (this.recording || !this.needed(now)) return;
        const { tl } = this;
        if (!tl) return;
        await VmixService.Instance.StartRecording();
        this.recording = true;
        const raw: RawFile = { path: null, start: Date.now(), end: null };
        tl.raws.push(raw);
        this.save();
        this.host.setRecording(true);
        this.host.log('Started recording');
        // vMix names the file once it is writing.
        setTimeout(() => {
            this.run(async () => {
                if (raw.end === null && !raw.path) {
                    raw.path = await VmixService.Instance.GetCurrentRecording();
                    this.save();
                }
            });
        }, 3000);
    }

    private async stopRecording() {
        const { tl } = this;
        if (!tl) return;
        const raw = tl.raws.find((r) => r.end === null);
        if (raw && !raw.path) {
            raw.path = await VmixService.Instance.GetCurrentRecording().catch(
                () => null
            );
        }
        await VmixService.Instance.StopRecording();
        this.recording = false;
        this.host.setRecording(false);
        this.host.log('Stopped recording');
        if (!raw) return;
        raw.end = Date.now();
        raw.ready = false;
        this.save();
        // vMix finishes the file after it reports stopped; the wait runs off
        // the event chain so a Match Start meanwhile is not held up.
        const { folder } = tl;
        this.moveToOriginals(raw.path, folder)
            .catch(() => raw.path)
            .then((moved) =>
                this.run(async () => {
                    raw.path = moved;
                    raw.ready = true;
                    if (this.tl?.folder === folder) {
                        this.save();
                        this.finishReady();
                    }
                })
            )
            .catch((e) => logger.error('Raw file move failed', e));
    }

    // Move a stopped raw file into Originals once vMix has finished it. If it
    // never finishes or the move fails, the file stays where vMix put it.
    // eslint-disable-next-line class-methods-use-this
    private async moveToOriginals(
        file: string | null,
        folder: string
    ): Promise<string | null> {
        if (!file) return null;
        if (!(await waitForFinishedVideo(file))) {
            logger.warn(`${file} never finished writing; left in place`);
            return file;
        }
        const dir = path.join(folder, 'Originals');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        const target = path.join(dir, `raw ${path.basename(file)}`);
        try {
            await moveVideo(file, target);
            return target;
        } catch (e) {
            logger.warn(`Could not move ${file} into Originals`, e);
            return file;
        }
    }

    // #endregion

    // #region making the videos

    // The windows a run's video is cut from, or null while one is still open.
    // eslint-disable-next-line class-methods-use-this
    private windows(r: FtcRun): [number, number][] | null {
        const play: [number, number] = [
            r.start - LEAD_SECONDS * 1000,
            r.playEnd,
        ];
        if (r.post !== null) {
            // No lead here: the second before a post still shows the
            // previous screen (another match's results or timer).
            const from = Math.max(r.post, r.playEnd);
            return [play, [from, r.post + REVEAL_SECONDS * 1000]];
        }
        if (r.gaveUp) return [play];
        return null;
    }

    // Make every video whose footage is complete: all its windows ended and
    // covered by stopped raw files.
    private finishReady() {
        const { tl } = this;
        if (!tl) return;
        // Footage still being written, or finished but not yet in Originals.
        const open = tl.raws.find((r) => r.end === null || r.ready === false);
        tl.runs.forEach((r) => {
            if (r.done) return;
            if (r.abortAt !== null) {
                // Footage stays in Originals; the replay is the match.
                if (open && open.start < r.abortAt + ABORT_KEEP_SECONDS * 1000)
                    return;
                r.done = true;
                this.save();
                const { folder } = tl;
                const updated = updateMatch(folder, r.id, {
                    status: 'error',
                    error: 'Aborted',
                    endedAt: r.abortAt,
                    processing: undefined,
                });
                if (updated) this.host.record(updated);
                return;
            }
            const wins = this.windows(r);
            if (!wins) return;
            const lastEnd = Math.max(...wins.map((w) => w[1]));
            // Footage still being written for one of the windows.
            if (open && open.start < lastEnd) return;
            r.done = true;
            this.save();
            this.make(r, wins);
        });
    }

    // Cut the windows out of the raw files and join them into the match
    // video. Queued with FRC's cuts, one encode at a time.
    private make(r: FtcRun, wins: [number, number][]) {
        const { tl } = this;
        if (!tl) return;
        const { folder } = tl;
        const pieces: { file: string; from: number; seconds: number }[] = [];
        // When each piece was recorded, for the loudness check.
        const segments: WallSegment[] = [];
        wins.forEach(([a, b]) => {
            tl.raws.forEach((raw) => {
                if (!raw.path || raw.end === null) return;
                const from = Math.max(a, raw.start);
                const to = Math.min(b, raw.end);
                // A sliver no longer than the lead is the end of an earlier
                // file (an aborted match before its replay), not this match.
                if (to - from <= LEAD_SECONDS * 1000 + 200) return;
                pieces.push({
                    file: raw.path,
                    from: (from - raw.start) / 1000,
                    seconds: (to - from) / 1000,
                });
                segments.push({ wallStart: from, seconds: (to - from) / 1000 });
            });
        });

        const event = this.host.event();
        const fileName = matchFileName(event, {
            MatchState: 'GameSpecificData',
            Level: r.level,
            MatchNumber: r.number,
            PlayNumber: 1,
            ShortName: r.shortName,
        });
        const target = path.join(folder, fileName);
        const queued = updateMatch(folder, r.id, {
            status: 'recorded',
            endedAt: r.playEnd,
            processing: { state: 'queued' },
        });
        if (queued) this.host.record(queued);

        enqueueCut(async () => {
            const started = updateMatch(folder, r.id, {
                processing: { state: 'processing' },
            });
            if (started) this.host.record(started);
            try {
                if (!pieces.length)
                    throw new Error('No footage for this match');
                // Written beside the target, then renamed, so the uploader
                // never sees a half-made video.
                const temp = target.replace(/(\.[^.]+)$/, '.making$1');
                try {
                    await assembleClips(pieces, temp);
                    fs.renameSync(temp, target);
                } finally {
                    fs.rmSync(temp, { force: true });
                }
                const done = updateMatch(folder, r.id, {
                    fileName,
                    filePath: target,
                    processing: { state: 'done', outputPath: target },
                });
                if (done) this.host.record(done);
                queueLoudness(folder, r.id, target, segments, (rec) =>
                    this.host.record(rec)
                );
                this.host.log(
                    `${fileName}${wins.length > 1 ? '' : ' (no scores posted)'}`
                );
            } catch (e: any) {
                // Stays "recorded" so the Auto AV tab offers a retry.
                const failed = updateMatch(folder, r.id, {
                    processing: {
                        state: 'error',
                        error: String(e?.message ?? e),
                    },
                });
                if (failed) this.host.record(failed);
                this.host.log(`Could not make ${fileName}: ${e?.message ?? e}`);
            }
        });
    }

    // The match being played right now (start to start + match length), or
    // null. An aborted match is not in play.
    public inPlay(): { shortName: string; level: string } | null {
        const now = Date.now();
        const r = [...(this.tl?.runs ?? [])]
            .reverse()
            .find(
                (x) => x.start <= now && now < x.playEnd && x.abortAt === null
            );
        return r ? { shortName: r.shortName, level: r.level } : null;
    }

    // For the status API: whether vMix is recording for FTC, matches still
    // waiting for their scores, and matches whose video is not made yet.
    public summary() {
        const { tl } = this;
        const open = (tl?.runs ?? []).filter((r) => !r.done);
        return {
            recording: this.recording,
            folder: tl?.folder ?? null,
            waitingForScores: open
                .filter(
                    (r) => r.post === null && r.abortAt === null && !r.gaveUp
                )
                .map((r) => ({
                    match: r.shortName,
                    field: r.field,
                    startedAt: r.start,
                })),
            pendingVideos: open.map((r) => r.shortName),
        };
    }

    // Make a match's video again (the Cut button), from the same windows.
    public remake(folder: string, id: string) {
        this.run(async () => {
            const tl = await this.timeline();
            if (!tl || tl.folder !== folder) return;
            const r = tl.runs.find((x) => x.id === id);
            const wins = r && this.windows(r);
            if (!r || !wins || r.abortAt !== null) return;
            r.done = true;
            this.save();
            this.make(r, wins);
        });
    }

    // #endregion
}
