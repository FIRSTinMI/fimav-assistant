import * as fs from 'fs';
import path from 'path';
import Event from 'models/Event';
import FMSMatchStatus from 'models/FMSMatchState';
import { getStore } from '../main/store';

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
        const playString =
            matchStatus.PlayNumber > 1
                ? ` (Play #${matchStatus.PlayNumber})`
                : '';
        return `${eventName} - ${matchStatus.Level} Match ${matchStatus.MatchNumber}${playString}.mp4`;
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

export default async function attemptRename(
    event: Event | null,
    videoLocation: string | null,
    matchStatus: FMSMatchStatus
): Promise<string> {
    return new Promise((resolve, reject) => {
        try {
            // Check if video location exists
            if (videoLocation === null) {
                reject(new Error('Video location is null'));
                return;
            }

            // VMix video location exists
            if (!fs.existsSync(videoLocation)) {
                reject(new Error('Video location does not exist'));
                return;
            }

            let builder: FileNameMode = getStore().get(
                'autoAv.fileNameMode',
                'in-season'
            );
            if (event?.isOfficial === false) {
                builder = 'off-season';
            } else if (event?.isOfficial === true) {
                builder = 'in-season';
            }

            // Manual overrides from settings: a typed event name always wins,
            // and an explicit save folder redirects where files land.
            const nameOverride = getStore()
                .get('autoAv.eventNameOverride', '')
                .trim();
            const saveFolderOverride = getStore()
                .get('autoAv.saveFolder', '')
                .trim();

            const effectiveEvent: Event | null = nameOverride
                ? ({
                      ...(event ?? {}),
                      name: nameOverride,
                      code: nameOverride,
                  } as Event)
                : event;

            const newFileName = fileNameBuilders[builder](
                effectiveEvent,
                matchStatus
            );

            // Event-named folder, under the configured save folder if set,
            // otherwise alongside the vMix recording (videoLocation ends in the
            // file name, so "../" gives its directory).
            const baseFolder = saveFolderOverride
                ? path.resolve(saveFolderOverride)
                : path.resolve(videoLocation, '../');
            const eventFolder = path.resolve(
                baseFolder,
                `${new Date().getFullYear()} ${
                    effectiveEvent?.name ?? 'Unknown Event'
                }`
            );
            if (!fs.existsSync(eventFolder)) {
                fs.mkdirSync(eventFolder, { recursive: true });
            }

            const target = path.resolve(eventFolder, newFileName);
            const source = path.resolve(videoLocation);

            // Rename/move the file; fall back to copy+delete across drives
            // (renameSync throws EXDEV when the save folder is on another disk).
            try {
                fs.renameSync(source, target);
            } catch (err) {
                if ((err as { code?: string }).code === 'EXDEV') {
                    fs.copyFileSync(source, target);
                    fs.unlinkSync(source);
                } else {
                    throw err;
                }
            }

            // Remember the real folder so the Auto AV tab can show the exact
            // path even when no save folder is configured.
            getStore().set('autoAv.lastSaveFolder', eventFolder);

            // Resolve
            resolve(target);
        } catch (e) {
            reject(e);
        }
    });
}
