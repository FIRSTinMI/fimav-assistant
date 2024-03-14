import * as fs from 'fs';
import path from 'path';
import FMSMatchStatus from '../models/FMSMatchState';

export default async function attemptRename(
    eventName: string,
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

            // Build the file name
            const playString =
                matchStatus.PlayNumber > 1
                    ? ` (Play #${matchStatus.PlayNumber})`
                    : '';
            const newFileName = `${eventName} - ${matchStatus.Level} Match ${matchStatus.MatchNumber}${playString}.mp4`;

            // Check if event name folder exists (videoLocation has the file name at the end, so we must "go up" one directory)
            const eventFolder = path.resolve(videoLocation, '../', eventName);
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
