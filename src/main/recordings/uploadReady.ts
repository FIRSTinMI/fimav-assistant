import { MatchRecord } from '../../models/MatchRecord';

// Whether a filed match video is final, so the uploader may be told to take
// it now. Final = cut done, never going to be cut (no processing state, or
// "unprocessed"), or the cut failed and the original was put back ("error").
// Queued or processing = a cut is coming: announcing then made the uploader
// upload the raw file while the cut moved it away.
export default function isReadyForUpload(rec: MatchRecord): boolean {
    if (!rec?.filePath) return false;
    const ps = rec.processing?.state;
    if (ps === 'done') return true;
    return (
        rec.status === 'recorded' &&
        (!ps || ps === 'unprocessed' || ps === 'error')
    );
}
