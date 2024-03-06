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
                matchStatus.PlayNumber > 1 ? ` (Play #${matchStatus.PlayNumber})` : '';
            const newFileName = `${eventName} - ${matchStatus.Level} Match ${matchStatus.MatchNumber}${playString}.mp4`;

            // Check if event name folder exists
            const eventFolder = path.resolve(videoLocation, eventName);
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

// Matches the filename and grabs each part in the order that it occurs in the file name
// const fileNameRegex =
//     /.* - (\d*) ([a-zA-Z]*) (\d*) - (\d*)-(\d*)-(\d*) ([a-zA-Z]*).*/;

// function vmixFilenameToDate(filename: string): Date | null {
//     // Vmix file name example: "capture - 23 September 2023 - 08-35-04 AM.mp4"
//     // Regex makes it this:
//     // ['capture - 23 September 2023 - 08-35-04 AM.mp4', '23', 'September', '2023', '08', '35', '04', 'AM']
//     const [full, day, month, year, hour, minute, second, ampm] =
//         fileNameRegex.exec(filename) ?? [];
//     if (full === undefined) {
//         return null;
//     }

//     // Translate to date object
//     const date = new Date();
//     date.setFullYear(parseInt(year, 10));
//     date.setMonth(parseInt(month, 10) - 1);
//     date.setDate(parseInt(day, 10));
//     date.setHours(parseInt(hour, 10) + (ampm === 'PM' ? 12 : 0));
//     date.setMinutes(parseInt(minute, 10));
//     date.setSeconds(parseInt(second, 10));
//     date.setMilliseconds(0);
//     return date;
// }


// Get the newest file in a directory, igoring folders
export function getNewestFile(dir: string): string | null {
    const files = fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((f) => f.isFile())
        .map((f) => f.name)
        .sort((a, b) => {
            return (
                fs.statSync(path.join(dir, b)).mtime.getTime() -
                fs.statSync(path.join(dir, a)).mtime.getTime()
            );
        });

    return files.length > 0 ? path.join(dir, files[0]) : null;
}