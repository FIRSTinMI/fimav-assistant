import * as fs from "fs";
import FMSMatchStatus from "../models/FMSMatchState";
import path from "path";


export default async function attemptRename(eventName: string, videoLocation: string, recStartDate: Date, matchStatus: FMSMatchStatus): Promise<string> {
    return new Promise((resolve, reject) => {
        try {
            // VMix video location exists
            if (!fs.existsSync(videoLocation)) {
                reject('Video location does not exist');
                return;
            }

            // Get all files in the directory
            const files = fs.readdirSync(videoLocation);

            // Find the file that closest matches the start date. If we are more than 5 seconds off, fail.
            let closestFile: string | null = null;
            let closestFileDate: Date | null = null;

            // Loop over all files in directory
            for (const file of files) {
                const fileDate = vmixFilenameToDate(file);
                if (fileDate !== null) {
                    const diff = Math.abs(fileDate.getTime() - recStartDate.getTime());
                    if (diff < 5000) {
                        closestFile = file;
                        closestFileDate = fileDate;
                        break;
                    }
                }
            }

            // If we didn't find a file, fail
            if (closestFile === null || closestFileDate === null) {
                reject('Could not find a matching file to rename');
                return;
            }

            // Build the file name
            const playString = matchStatus.p2 > 1 ? ` (Play #${matchStatus.p2})` : '';
            const newFileName = `${eventName} - ${matchStatus.p4} Match ${matchStatus.p2}${playString}.mp4`;

            // Check if event name folder exists
            const eventFolder = path.resolve(videoLocation, eventName);
            if (!fs.existsSync(eventFolder)) {
                fs.mkdirSync(eventFolder);
            }

            // Rename and move the file
            fs.renameSync(path.resolve(videoLocation, closestFile), path.resolve(eventFolder, newFileName));

            // Resolve
            resolve(path.resolve(eventFolder, newFileName));
        } catch (e) {
            reject(e);
        }
    });
}

// Matches the filename and grabs each part in the order that it occurs in the file name
const fileNameRegex = /.* - (\d*) ([a-zA-Z]*) (\d*) - (\d*)-(\d*)-(\d*) ([a-zA-Z]*).*/;

function vmixFilenameToDate(filename: string): Date | null {
    // Vmix file name example: "capture - 23 September 2023 - 08-35-04 AM.mp4"
    // Regex makes it this:
    // ['capture - 23 September 2023 - 08-35-04 AM.mp4', '23', 'September', '2023', '08', '35', '04', 'AM']
    const [full, day, month, year, hour, minute, second, ampm] = fileNameRegex.exec(filename) ?? [];
    if (full === undefined) {
        return null;
    }

    // Translate to date object
    const date = new Date();
    date.setFullYear(parseInt(year));
    date.setMonth(parseInt(month) - 1);
    date.setDate(parseInt(day));
    date.setHours(parseInt(hour) + (ampm === 'PM' ? 12 : 0));
    date.setMinutes(parseInt(minute));
    date.setSeconds(parseInt(second));
    date.setMilliseconds(0);
    return date;

}