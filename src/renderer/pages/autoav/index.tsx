import { useEffect, useMemo, useState } from 'react';
import {
    Badge,
    Button,
    Card,
    Empty,
    Popconfirm,
    Space,
    Table,
    Tag,
    Typography,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import {
    CheckCircleTwoTone,
    CloseCircleTwoTone,
    FolderOpenOutlined,
    VideoCameraOutlined,
} from '@ant-design/icons';
import { AutoAVStatus } from 'models/AutoAVStatus';
import { MatchRecord, MatchTeam } from 'models/MatchRecord';
import './index.css';

const { Title, Text } = Typography;

const LEVEL_SHORT: Record<string, string> = {
    Qualification: 'Qual',
    Playoff: 'Playoff',
    Practice: 'Practice',
    'Match Test': 'Test',
};

function levelShort(level: string): string {
    return LEVEL_SHORT[level] ?? level;
}

function matchLabel(m: MatchRecord): string {
    const play = m.playNumber > 1 ? ` P${m.playNumber}` : '';
    return `${levelShort(m.level)} ${m.matchNumber}${play}`;
}

const STATUS_TAG: Record<MatchRecord['status'], { color: string; text: string }> =
    {
        recording: { color: 'processing', text: 'Recording' },
        recorded: { color: 'success', text: 'Recorded' },
        error: { color: 'error', text: 'Error' },
    };

// Merge an incoming record into the list (replace by id), newest first.
function mergeMatch(list: MatchRecord[], rec: MatchRecord): MatchRecord[] {
    const next = list.filter((m) => m.id !== rec.id);
    next.push(rec);
    return next.sort((a, b) => b.startedAt - a.startedAt);
}

function StatusBadge({ ok, label }: { ok: boolean; label: string }) {
    return (
        <Space size={6}>
            {ok ? (
                <CheckCircleTwoTone twoToneColor="#52c41a" />
            ) : (
                <CloseCircleTwoTone twoToneColor="#ff4d4f" />
            )}
            <Text>{label}</Text>
        </Space>
    );
}

function TeamCell({ teams }: { teams: MatchRecord['teams'] }) {
    if (!teams || (teams.red.length === 0 && teams.blue.length === 0)) {
        return <Text type="secondary">—</Text>;
    }
    const renderTrio = (trio: MatchTeam[], className: string) => (
        <div className={className}>
            {trio.map((t) => (
                <span
                    key={t.teamNumber}
                    className={t.card !== 'None' ? 'team-carded' : undefined}
                >
                    {t.teamNumber}
                </span>
            ))}
        </div>
    );
    return (
        <div className="team-cell">
            {renderTrio(teams.red, 'team-trio team-trio--red')}
            {renderTrio(teams.blue, 'team-trio team-trio--blue')}
        </div>
    );
}

function CardCell({ record }: { record: MatchRecord }) {
    const carded = [
        ...(record.teams?.red ?? []),
        ...(record.teams?.blue ?? []),
    ].filter((t) => t.card !== 'None');

    if (record.teams && carded.length === 0) {
        return <Text type="secondary">None</Text>;
    }
    if (carded.length === 0) {
        return <Text type="secondary">—</Text>;
    }
    return (
        <Space size={4} wrap>
            {carded.map((t) => (
                <Tag
                    key={t.teamNumber}
                    color={t.card === 'Red' ? 'red' : 'gold'}
                >
                    {t.teamNumber} {t.card}
                </Tag>
            ))}
        </Space>
    );
}

export default function AutoAVPage() {
    const [status, setStatus] = useState<AutoAVStatus | null>(null);
    const [matches, setMatches] = useState<MatchRecord[]>([]);

    useEffect(() => {
        if (!window.electron) return undefined;
        const { ipcRenderer } = window.electron;

        const offStatus = ipcRenderer.on(
            'autoav:status',
            (s: AutoAVStatus) => setStatus(s)
        );
        const offMatches = ipcRenderer.on(
            'autoav:matches',
            (list: MatchRecord[]) =>
                setMatches(
                    [...list].sort((a, b) => b.startedAt - a.startedAt)
                )
        );
        const offMatch = ipcRenderer.on('autoav:match', (rec: MatchRecord) =>
            setMatches((prev) => mergeMatch(prev, rec))
        );

        ipcRenderer.sendMessage('autoav:getState', []);

        return () => {
            offStatus();
            offMatches();
            offMatch();
        };
    }, []);

    const recordingMatch = useMemo(
        () => matches.find((m) => m.status === 'recording'),
        [matches]
    );

    const working = !!status?.fmsConnected && !!status?.vmix.reachable;

    const columns: ColumnsType<MatchRecord> = [
        {
            title: 'Match',
            key: 'match',
            render: (_, m) => <Text strong>{matchLabel(m)}</Text>,
        },
        {
            title: 'Teams (Red / Blue)',
            key: 'teams',
            render: (_, m) => <TeamCell teams={m.teams} />,
        },
        {
            title: 'Cards',
            key: 'cards',
            render: (_, m) => <CardCell record={m} />,
        },
        {
            title: 'File',
            key: 'file',
            render: (_, m) =>
                m.fileName ? (
                    <Text
                        className="file-name"
                        title={m.filePath ?? undefined}
                    >
                        {m.fileName}
                    </Text>
                ) : (
                    <Text type="secondary">—</Text>
                ),
        },
        {
            title: 'Time',
            key: 'time',
            render: (_, m) => (
                <Text type="secondary">
                    {new Date(m.startedAt).toLocaleTimeString()}
                </Text>
            ),
        },
        {
            title: 'Status',
            key: 'status',
            render: (_, m) => {
                const tag = STATUS_TAG[m.status];
                return (
                    <span title={m.error ?? undefined}>
                        <Tag color={tag.color}>{tag.text}</Tag>
                    </span>
                );
            },
        },
    ];

    return (
        <div className="autoav-page">
            <Space
                align="center"
                style={{
                    width: '100%',
                    justifyContent: 'space-between',
                    marginBottom: 12,
                }}
            >
                <Title level={3} style={{ margin: 0 }}>
                    <VideoCameraOutlined /> Auto AV
                </Title>
                <Badge
                    status={working ? 'success' : 'error'}
                    text={working ? 'Working' : 'Not ready'}
                />
            </Space>

            <div className="autoav-cards">
                <Card size="small" title="Status">
                    <Space direction="vertical" size={8}>
                        <StatusBadge
                            ok={!!status?.fmsConnected}
                            label="FMS connected"
                        />
                        <StatusBadge
                            ok={!!status?.vmix.reachable}
                            label="vMix reachable"
                        />
                        <StatusBadge
                            ok={!!status?.vmix.recording}
                            label="vMix recording"
                        />
                        {recordingMatch && (
                            <Text type="warning">
                                Recording now: {matchLabel(recordingMatch)}
                            </Text>
                        )}
                        {status?.lastMessage && (
                            <Text type="secondary">{status.lastMessage}</Text>
                        )}
                    </Space>
                </Card>

                <Card size="small" title="Detected event">
                    <Space direction="vertical" size={8}>
                        <Text strong>
                            {status?.currentEvent?.name ?? 'No event detected'}
                        </Text>
                        {status?.currentEvent?.code && (
                            <Text type="secondary">
                                Code: {status.currentEvent.code}
                            </Text>
                        )}
                        <Text type="secondary">
                            Naming: {status?.fileNameMode ?? 'in-season'}
                        </Text>
                        <Space size={6}>
                            <FolderOpenOutlined />
                            <Text
                                type="secondary"
                                className="file-name"
                                title={status?.saveFolder ?? undefined}
                            >
                                {status?.saveFolder ??
                                    'Saved alongside vMix recordings once recording starts'}
                            </Text>
                        </Space>
                    </Space>
                </Card>
            </div>

            <Space
                align="center"
                style={{
                    width: '100%',
                    justifyContent: 'space-between',
                    margin: '16px 0 8px',
                }}
            >
                <Title level={5} style={{ margin: 0 }}>
                    Recorded matches ({matches.length})
                </Title>
                {matches.length > 0 && (
                    <Popconfirm
                        title="Clear recorded match history?"
                        description="This only clears the list shown here, not the video files."
                        okText="Clear"
                        okButtonProps={{ danger: true }}
                        onConfirm={() =>
                            window.electron?.ipcRenderer.sendMessage(
                                'autoav:clearMatches',
                                []
                            )
                        }
                    >
                        <Button size="small" danger type="text">
                            Clear history
                        </Button>
                    </Popconfirm>
                )}
            </Space>

            {matches.length === 0 ? (
                <Empty description="No matches recorded yet" />
            ) : (
                <Table
                    rowKey="id"
                    size="small"
                    pagination={false}
                    columns={columns}
                    dataSource={matches}
                />
            )}
        </div>
    );
}
