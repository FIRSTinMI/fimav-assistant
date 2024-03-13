import { Col, Modal, Row, Space, Typography } from 'antd';
import HWCheckResponse, { StaticIpInfo } from 'models/HWCheckResponse';
import { Steppable } from 'models/steppable';
import { useEffect, useState } from 'react';
import StepBar from 'renderer/components/StepBar';
import ReadyHandler, { ReadyState } from 'renderer/components/ReadyHandler';
import AVTotes from '../../../../assets/photos/av_tote.jpg';
import CameraPelicans from '../../../../assets/photos/camera_pelican.jpg';

function HWCheck({ nextStep, previousStep }: Steppable) {
    const [networkReady, setNetworkReady] = useState(ReadyState.NotReady);
    const [ipReady, setIpReady] = useState(ReadyState.NotReady);
    const [audioReady, setAudioReady] = useState(ReadyState.NotReady);
    const [errors, setErrors] = useState<string[]>([]);
    const [ready, setReady] = useState<boolean>(false);
    const [modal, contextHolder] = Modal.useModal();

    useEffect(() => {
        // Fire off HW check and register listener
        window.electron.ipcRenderer.once<HWCheckResponse>(
            'hwcheck-response',
            async (arg: HWCheckResponse) => {
                if (arg.static_venue_ip.static) {
                    await promptStaticIp(false, arg.static_venue_ip);
                }

                setNetworkReady(
                    arg.av_ip_ready && arg.field_ip_ready && arg.venue_ip_ready
                        ? ReadyState.Ready
                        : ReadyState.Error
                );
                setIpReady(
                    arg.nics_found.length > 3
                        ? ReadyState.Ready
                        : ReadyState.Error
                );
                setAudioReady(
                    arg.audio_ready ? ReadyState.Ready : ReadyState.Error
                );
                setErrors(arg.errors);
                setReady(true);
            }
        );
        window.electron.ipcRenderer.sendMessage('hwcheck', []);
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const promptStaticIp = (failPrev: boolean, staticVenueIp: StaticIpInfo) => {
        return modal.confirm({
            title: 'Static IP Detected',
            cancelText: 'Leave It',
            okText: 'Enable DHCP (Recommended)',
            closable: false,
            keyboard: false,
            content: (
                <Space direction="vertical">
                    {failPrev && (
                        <Typography.Text type="danger">
                            The previous attempt to enable DHCP failed.  Please be sure to click &quot;Yes&quot; on the Windows popup that appears.
                        </Typography.Text>
                    )}
                    <Typography.Text>
                        Your IP address is set to a static address of <code>{staticVenueIp.ip}</code>.
                        If this is intentional, please click &quot;Leave It&quot; to continue.  Otherwise,
                        click &quot;Enable DHCP&quot; to allow the system to configure the network
                        adapter to use DHCP.
                    </Typography.Text>
                </Space>
            ),
            onOk: async () => {
                window.electron.ipcRenderer.sendMessage('set-venue-ip-dhcp', [staticVenueIp]);
                return new Promise<void>((resolve) => {
                    window.electron.ipcRenderer.once('set-venue-ip-dhcp-response', (success) => {
                        resolve();
                        if (!success) {
                            promptStaticIp(true, staticVenueIp);
                        }
                    });
                });;
            },
        });
    }

    return (
        <>
            {/* Modal for errors */}
            {contextHolder}
            <Space
                direction="vertical"
                style={{ textAlign: 'center', width: '100%' }}
            >
                <Typography.Title level={1}>
                    Hardware Self-Check
                </Typography.Title>
                <Typography.Title level={5}>
                    Hang tight... We&apos;re checking to make sure that your AV
                    computer is ready for this event!
                </Typography.Title>
                <Typography.Text>
                    <ReadyHandler ready={networkReady} /> Network Adapters
                </Typography.Text>
                <Typography.Text>
                    <ReadyHandler ready={ipReady} /> IP Addresses
                </Typography.Text>
                <Typography.Text>
                    <ReadyHandler ready={audioReady} /> Audio Devices
                </Typography.Text>

                {errors && errors.length > 0 && (
                    <>
                        <Typography.Text>
                            Don&apos;t worry about any errors below. We&apos;ll
                            help you get these resolved soon!
                        </Typography.Text>
                        {errors.map((error) => (
                            <Typography.Text key={error} type="danger">
                                {error}
                            </Typography.Text>
                        ))}
                    </>
                )}

                {/* Meanwhile, locate your AV Totes */}
                <Typography.Title level={3}>
                    Meanwhile, please locate your AV Tote and orange camera
                    pelican. They are pictured below.
                </Typography.Title>

                <Row>
                    <Col span={12}>
                        <img
                            src={AVTotes}
                            alt="Gray AV Tote"
                            style={{ width: '80%' }}
                        />
                    </Col>
                    <Col span={12}>
                        <img
                            src={CameraPelicans}
                            alt="Camera pelican"
                            style={{ width: '80%' }}
                        />
                    </Col>
                </Row>
            </Space>

            <StepBar
                nextStep={nextStep}
                previousStep={previousStep}
                showNext
                showPrev
                nextDisabled={!ready}
            />
        </>
    );
}

export default HWCheck;
