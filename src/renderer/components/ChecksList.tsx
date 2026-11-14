import { Button, Empty, Spin, Tag, Tooltip, Typography } from 'antd';
import { CheckResult, CheckState } from '../../models/Checks';
import useChecks, { ignoreCheck, unignoreCheck } from '../hooks/checks';
import CheckFixButton from './CheckFixButton';
import CheckDocButton from './CheckDocButton';
import './ChecksList.css';

const { Text } = Typography;

const GROUPS: CheckResult['group'][] = [
    'Hardware',
    'Stream',
    'Audio',
    'Recording',
    'Captions',
    'Display',
];

const STATE_TAG: Record<CheckState, { color: string; label: string }> = {
    ok: { color: 'success', label: 'OK' },
    warning: { color: 'warning', label: 'Warning' },
    critical: { color: 'error', label: 'Critical' },
    unknown: { color: 'default', label: 'Not checked' },
};

const time = (ms: number) =>
    new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

function Row({ check }: { check: CheckResult }) {
    const failing = check.state === 'warning' || check.state === 'critical';
    // Hardware is list only, so it has nothing to ignore.
    const ignorable = failing && check.group !== 'Hardware';
    const tag = STATE_TAG[check.state];
    return (
        <div className="check-row">
            <Text strong className="check-row__label">
                {check.label}
            </Text>
            <span className="check-row__state">
                {check.ignoredUntil ? (
                    <Tag>Ignored until {time(check.ignoredUntil)}</Tag>
                ) : (
                    <Tag color={tag.color}>{tag.label}</Tag>
                )}
            </span>
            <Tooltip title={failing ? check.hint : null}>
                <Text type="secondary" className="check-row__detail">
                    {check.detail}
                </Text>
            </Tooltip>
            <span className="check-row__action">
                {check.ignoredUntil && (
                    <Button
                        size="small"
                        onClick={() => unignoreCheck(check.id)}
                    >
                        Undo
                    </Button>
                )}
                {!check.ignoredUntil && failing && (
                    <>
                        <CheckFixButton check={check} />
                        <CheckDocButton check={check} />
                        {ignorable && (
                            <Button
                                size="small"
                                onClick={() => ignoreCheck(check.id)}
                            >
                                Ignore
                            </Button>
                        )}
                    </>
                )}
            </span>
        </div>
    );
}

export default function ChecksList() {
    const checks = useChecks();
    if (!checks) {
        return (
            <div className="checks-page">
                <Spin />
            </div>
        );
    }
    if (!checks.length) {
        return (
            <div className="checks-page">
                <Empty description="No checks" />
            </div>
        );
    }
    return (
        <div className="checks-page">
            {GROUPS.map((g) => {
                const rows = checks.filter((c) => c.group === g);
                if (!rows.length) return null;
                return (
                    <section key={g} className="checks-group">
                        <h3>{g}</h3>
                        {rows.map((c) => (
                            <Row key={c.id} check={c} />
                        ))}
                    </section>
                );
            })}
        </div>
    );
}
