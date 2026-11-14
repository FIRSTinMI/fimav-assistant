import { useState } from 'react';
import { Button, message } from 'antd';
import { CheckResult } from '../../models/Checks';
import { fixCheck } from '../hooks/checks';

// The one-click repair a check offers for its current problem, if any.
export default function CheckFixButton({ check }: { check: CheckResult }) {
    const [busy, setBusy] = useState(false);
    if (!check.fix) return null;
    const run = async () => {
        setBusy(true);
        const r = await fixCheck(check.id);
        setBusy(false);
        if (!r.ok) message.error(r.message ?? `${check.label}: failed`);
    };
    return (
        <Button size="small" type="primary" loading={busy} onClick={run}>
            {check.fix}
        </Button>
    );
}
