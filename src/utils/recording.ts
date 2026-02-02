import * as fs from 'fs';
import path from 'path';
import Event from 'models/Event';
import FMSMatchStatus from 'models/FMSMatchState';
import { getStore } from '../main/store';

export type FileNameMode = 'in-season' | 'off-season';

const fileNameBuilders: Record<FileNameMode, (_event: Event | null, _matchStatus: FMSMatchStatus) => string> = {
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
            if (matchStatus.MatchNumber >= 14) {
                match = `F1M${matchStatus.MatchNumber - 13}`;
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
            matchStatus.PlayNumber > 1
                ? `_P${matchStatus.PlayNumber}`
                : '';
        return `${match}${play}_${eventCode}.mp4`;
    },
    'off-season': (event, matchStatus) => {
        const eventName = `${new Date().getFullYear()} ${event?.name ?? 'Unknown Event'}`;
        const playString = matchStatus.PlayNumber > 1 ? ` (Play #${matchStatus.PlayNumber})` : '';
        return `${eventName} - ${matchStatus.Level} Match ${matchStatus.MatchNumber}${playString}.mp4`;
    }
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
            
            let builder: FileNameMode = getStore().get('autoAv.fileNameMode', 'in-season');
            if (event?.isOfficial === false) {
                builder = 'off-season';
            } else if (event?.isOfficial === true) {
                builder = 'in-season';
            }

            const newFileName = fileNameBuilders[builder](event, matchStatus);

            // Check if event name folder exists (videoLocation has the file name at the end, so we must "go up" one directory)
            const eventFolder = path.resolve(videoLocation, '../', `${new Date().getFullYear()} ${event?.name ?? 'Unknown Event'}`);
            if (!fs.existsSync(eventFolder)) {
                fs.mkdirSync(eventFolder);
            }

            // Rename and move the file
            fs.renameSync(
                path.resolve(videoLocation),
                path.resolve(eventFolder, newFileName)
            );

            // Resolve
            resolve(path.resolve(eventFolder, newFileName));
        } catch (e) {
            reject(e);
        }
    });
}
