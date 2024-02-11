import * as fs from 'fs';
import path from 'path';
import FMSMatchStatus from '../models/FMSMatchState';

export default async function attemptRename(
    eventName: string,
    videoLocation: string,
    recStartDate: Date,
    matchStatus: FMSMatchStatus
): Promise<string> {
    return new Promise((resolve, reject) => {
        try {
            // VMix video location exists
            if (!fs.existsSync(videoLocation)) {
                reject(new Error('Video location does not exist'));
                return;
            }

            // Get all files in the directory
            const files = fs.readdirSync(videoLocation);

            // Find the file that closest matches the start date. If we are more than 5 seconds off, fail.
            let closestFile: string | null = null;
            let closestFileDate: Date | null = null;

            // Loop over all files in directory
            files.every((file) => {
                const fileDate = vmixFilenameToDate(file);
                if (fileDate !== null) {
                    const diff = Math.abs(
                        fileDate.getTime() - recStartDate.getTime()
                    );
                    if (diff < 5000) {
                        closestFile = file;
                        closestFileDate = fileDate;
                        return false;
                    }
                }

                return true;
            })

            // If we didn't find a file, fail
            if (closestFile === null || closestFileDate === null) {
                reject(new Error('Could not find a matching file to rename'));
                return;
            }

            // Build the file name
            const playString =
                matchStatus.p2 > 1 ? ` (Play #${matchStatus.p2})` : '';
            const newFileName = `${eventName} - ${matchStatus.p4} Match ${matchStatus.p2}${playString}.mp4`;

            // Check if event name folder exists
            const eventFolder = path.resolve(videoLocation, eventName);
            if (!fs.existsSync(eventFolder)) {
                fs.mkdirSync(eventFolder);
            }

            // Rename and move the file
            fs.renameSync(
                path.resolve(videoLocation, closestFile),
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
const fileNameRegex =
    /.* - (\d*) ([a-zA-Z]*) (\d*) - (\d*)-(\d*)-(\d*) ([a-zA-Z]*).*/;

function vmixFilenameToDate(filename: string): Date | null {
    // Vmix file name example: "capture - 23 September 2023 - 08-35-04 AM.mp4"
    // Regex makes it this:
    // ['capture - 23 September 2023 - 08-35-04 AM.mp4', '23', 'September', '2023', '08', '35', '04', 'AM']
    const [full, day, month, year, hour, minute, second, ampm] =
        fileNameRegex.exec(filename) ?? [];
    if (full === undefined) {
        return null;
    }

    // Translate to date object
    const date = new Date();
    date.setFullYear(parseInt(year, 10));
    date.setMonth(parseInt(month, 10) - 1);
    date.setDate(parseInt(day, 10));
    date.setHours(parseInt(hour, 10) + (ampm === 'PM' ? 12 : 0));
    date.setMinutes(parseInt(minute, 10));
    date.setSeconds(parseInt(second, 10));
    date.setMilliseconds(0);
    return date;
}
