import { ReactNode } from 'react';
import { Button, Space, Tag, Tooltip, Typography } from 'antd';
import {
    CaretRightOutlined,
    ReloadOutlined,
    SettingOutlined,
    StopOutlined,
} from '@ant-design/icons';
import './AddonControlRow.css';

const { Text } = Typography;

interface AddonControlRowProps {
    // Status dot + label
    running: boolean;
    statusLabel?: string;
    // Optional version tag; if onVersionClick is set it becomes a button
    version?: string | null;
    onVersionClick?: () => void;
    versionTooltip?: string;
    // Lifecycle controls - only rendered when the handler is provided
    onStart?: () => void;
    onRestart?: () => void;
    onStop?: () => void;
    // Settings gear - only rendered when provided
    onSettings?: () => void;
    // Disable buttons while an action is in flight
    busy?: boolean;
    // Extra actions rendered before the controls
    extra?: ReactNode;
}

// The shared second bar under the tab bar: a running indicator, optional
// version, and optional start/restart/stop + settings. Used by every addon tab
// so vMix / Live Captions / Auto AV read as one consistent app.
export default function AddonControlRow({
    running,
    statusLabel,
    version,
    onVersionClick,
    versionTooltip,
    onStart,
    onRestart,
    onStop,
    onSettings,
    busy = false,
    extra,
}: AddonControlRowProps) {
    const label = statusLabel ?? (running ? 'Running' : 'Stopped');

    const versionTag = version ? (
        <Tag
            className={`addon-version${
                onVersionClick ? ' addon-version--btn' : ''
            }`}
            onClick={onVersionClick}
        >
            v{version}
        </Tag>
    ) : null;

    // Lifecycle controls: start when stopped, restart+stop when running. Only
    // rendered when all three handlers are provided.
    let controls: ReactNode = null;
    if (onStart && onRestart && onStop) {
        controls = running ? (
            <>
                <Button
                    icon={<ReloadOutlined />}
                    onClick={onRestart}
                    loading={busy}
                >
                    Restart
                </Button>
                <Button
                    icon={<StopOutlined />}
                    danger
                    onClick={onStop}
                    disabled={busy}
                >
                    Stop
                </Button>
            </>
        ) : (
            <Button
                type="primary"
                icon={<CaretRightOutlined />}
                onClick={onStart}
                loading={busy}
            >
                Start
            </Button>
        );
    }

    return (
        <div className="addon-control-row">
            <Space size={10} align="center">
                <span
                    className={`addon-dot ${
                        running ? 'addon-dot--on' : 'addon-dot--off'
                    }`}
                />
                <Text strong>{label}</Text>
                {version && onVersionClick ? (
                    <Tooltip
                        title={versionTooltip ?? 'Click to check for updates'}
                    >
                        {versionTag}
                    </Tooltip>
                ) : (
                    versionTag
                )}
            </Space>

            <Space size={8}>
                {extra}
                {onSettings && (
                    <Button
                        icon={<SettingOutlined />}
                        onClick={onSettings}
                    >
                        Settings
                    </Button>
                )}
                {controls}
            </Space>
        </div>
    );
}

AddonControlRow.defaultProps = {
    statusLabel: undefined,
    version: undefined,
    onVersionClick: undefined,
    versionTooltip: undefined,
    onStart: undefined,
    onRestart: undefined,
    onStop: undefined,
    onSettings: undefined,
    busy: false,
    extra: undefined,
};
