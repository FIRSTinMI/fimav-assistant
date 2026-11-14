import * as fs from 'fs';
import path from 'path';
import Event from 'models/Event';
import FMSMatchStatus from 'models/FMSMatchState';
import { getStore } from '../main/store';
import { moveVideo, waitForFinishedVideo } from '../main/cutMatch';

export type FileNameMode = 'in-season' | 'off-season';

// In an 8-alliance double elimination bracket, FMS numbers the 13 elimination
// matches 1-13 and the finals from 14 up. Shared so file naming and FMS result
// lookups agree on where finals begin.
export const DOUBLE_ELIM_FINAL_START = 14;

export function isDoubleElimFinal(matchNumber: number): boolean {
    return matchNumber >= DOUBLE_ELIM_FINAL_START;
}

const fileNameBuilders: Record<
    FileNameMode,
    (_event: Event | null, _matchStatus: FMSMatchStatus) => string
> = {
    'in-season': (event, matchStatus) => {
        const eventCode = event?.code ?? event?.name ?? 'Unknown_Event';
        if (matchStatus.ShortName) {
            return `${matchStatus.ShortName}_${eventCode}.mp4`;
        }

        // Build the file name
        let match = '';
        switch (matchStatus.Level) {
            case 'Qualification':
                match = `QM${matchStatus.MatchNumber}`;
                break;
            case 'Playoff':
                // TODO: Make this more resilient to playoff types other than 8-alliance double elim
                if (isDoubleElimFinal(matchStatus.MatchNumber)) {
                    match = `F1M${
                        matchStatus.MatchNumber - (DOUBLE_ELIM_FINAL_START - 1)
                    }`;
                } else {
                    match = `SF${matchStatus.MatchNumber}M1`;
                }
                break;
            case 'Practice':
                match = `zz_PR${matchStatus.MatchNumber}`;
                break;
            case 'Match Test':
            case 'None':
                match = `zz_TM${matchStatus.MatchNumber}`;
                break;
            default:
                match = `zz_${matchStatus.Level} ${matchStatus.MatchNumber}`;
                break;
        }
        const play =
            matchStatus.PlayNumber > 1 ? `_P${matchStatus.PlayNumber}` : '';
        return `${match}${play}_${eventCode}.mp4`;
    },
    'off-season': (event, matchStatus) => {
        const eventName = `${new Date().getFullYear()} ${
            event?.name ?? 'Unknown Event'
        }`;
        if (matchStatus.ShortName) {
            return `${eventName} - ${matchStatus.Level} ${matchStatus.ShortName}.mp4`;
        }
        const playString =
            matchStatus.PlayNumber > 1
                ? ` (Play #${matchStatus.PlayNumber})`
                : '';
        // A test match is "Test Match N", which the uploader reads as a test
        // and never uploads.
        const level =
            matchStatus.Level === 'None' || matchStatus.Level === 'Match Test'
                ? 'Test'
                : matchStatus.Level;
        return `${eventName} - ${level} Match ${matchStatus.MatchNumber}${playString}.mp4`;
    },
};

// The per-event folder name recordings are filed into, e.g. "2026 <Event>".
// Shared so the Auto AV tab shows the same folder attemptRename will create.
export function eventFolderName(event: Event | null): string {
    return `${new Date().getFullYear()} ${event?.name ?? 'Unknown Event'}`;
}

// An example output filename for the given event + naming mode, for showing the
// user what their files will look like (a Qualification match 1 sample).
export function sampleFileName(
    event: Event | null,
    mode: FileNameMode
): string {
    const sample = {
        Level: 'Qualification',
        MatchNumber: 1,
        PlayNumber: 1,
    } as FMSMatchStatus;
    return fileNameBuilders[mode](event, sample);
}

// The mode the event's files are named in: FMS / FTC Live's official flag,
// else the stored choice.
function namingMode(event: Event | null): FileNameMode {
    if (event?.isOfficial === false) return 'off-season';
    if (event?.isOfficial === true) return 'in-season';
    return getStore().get('autoAv.fileNameMode', 'in-season');
}

// A typed event name in settings always wins over the field system's.
function withNameOverride(event: Event | null): Event | null {
    const nameOverride = getStore().get('autoAv.eventNameOverride', '').trim();
    return nameOverride
        ? ({
              ...(event ?? {}),
              name: nameOverride,
              code: nameOverride,
          } as Event)
        : event;
}

// The file name a match is filed under, the same as attemptRename picks.
export function matchFileName(
    event: Event | null,
    matchStatus: FMSMatchStatus
): string {
    return fileNameBuilders[namingMode(event)](
        withNameOverride(event),
        matchStatus
    );
}

export default async function attemptRename(
    event: Event | null,
    videoLocation: string | null,
    matchStatus: FMSMatchStatus
): Promise<string> {
    // Check if video location exists
    if (videoLocation === null) {
        throw new Error('Video location is null');
    }

    // VMix video location exists
    if (!fs.existsSync(videoLocation)) {
        throw new Error('Video location does not exist');
    }

    // vMix finishes the file (its MP4 index) after it reports the recording
    // stopped; moving it before then leaves an unreadable copy.
    if (!(await waitForFinishedVideo(videoLocation))) {
        throw new Error('vMix never finished writing the recording');
    }

    // Manual overrides from settings: a typed event name always wins, and an
    // explicit save folder redirects where files land.
    const saveFolderOverride = getStore().get('autoAv.saveFolder', '').trim();
    const effectiveEvent = withNameOverride(event);
    const newFileName = matchFileName(event, matchStatus);

    // Event-named folder, under the configured save folder if set, otherwise
    // alongside the vMix recording (videoLocation ends in the file name, so
    // "../" gives its directory).
    const baseFolder = saveFolderOverride
        ? path.resolve(saveFolderOverride)
        : path.resolve(videoLocation, '../');
    const eventFolder = path.resolve(
        baseFolder,
        `${new Date().getFullYear()} ${effectiveEvent?.name ?? 'Unknown Event'}`
    );
    if (!fs.existsSync(eventFolder)) {
        fs.mkdirSync(eventFolder, { recursive: true });
    }

    const target = path.resolve(eventFolder, newFileName);

    // Rename, or copy + check + delete across drives.
    await moveVideo(path.resolve(videoLocation), target);

    // Remember the real folder so the Auto AV tab can show the exact path
    // even when no save folder is configured.
    getStore().set('autoAv.lastSaveFolder', eventFolder);

    return target;
}
