import { Button, Tooltip } from 'antd';
import { WarningFilled } from '@ant-design/icons';
import { isAlerting } from '../../models/Checks';
import useChecks, { ignoreCheck } from '../hooks/checks';
import { openChecks } from './ChecksDialog';
import CheckFixButton from './CheckFixButton';
import CheckDocButton from './CheckDocButton';
import './CheckBanner.css';

// Up to this many bars; past it, the worst MAX - 1 and a "+n more" bar.
const MAX = 3;

// A bar at the top of every page for each failing check that is not
// ignored. It stays up only while the problem lasts.
export default function CheckBanner() {
    const checks = useChecks();
    // Critical first, otherwise in check order (sort is stable).
    const alerts = (checks ?? [])
        .filter(isAlerting)
        .sort(
            (a, b) =>
                Number(b.state === 'critical') - Number(a.state === 'critical')
        );
    if (!alerts.length) return null;
    const shown = alerts.length > MAX ? alerts.slice(0, MAX - 1) : alerts;
    const hidden = alerts.slice(shown.length);
    const hiddenState = hidden.some((c) => c.state === 'critical')
        ? 'critical'
        : 'warning';
    return (
        <div className="check-banner">
            {shown.map((c) => (
                <div
                    key={c.id}
                    className={`check-banner__row check-banner__row--${c.state}`}
                >
                    <WarningFilled />
                    <Tooltip title={c.hint}>
                        <button
                            type="button"
                            className="check-banner__text"
                            onClick={openChecks}
                        >
                            <strong>{c.label}</strong>
                            <span>{c.detail}</span>
                        </button>
                    </Tooltip>
                    <CheckFixButton check={c} />
                    <CheckDocButton check={c} />
                    <Button size="small" onClick={() => ignoreCheck(c.id)}>
                        Ignore
                    </Button>
                </div>
            ))}
            {hidden.length > 0 && (
                <button
                    type="button"
                    className={`check-banner__row check-banner__more check-banner__row--${hiddenState}`}
                    onClick={openChecks}
                >
                    +{hidden.length} more problems detected <u>View</u>
                </button>
            )}
        </div>
    );
}
