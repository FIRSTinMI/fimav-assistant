import { Col, Row, Space, Typography } from 'antd';
import HWCheckResponse from 'models/HWCheckResponse';
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

    useEffect(() => {
        // Fire off HW check and register listener
        window.electron.ipcRenderer.once<HWCheckResponse>(
            'hwcheck-response',
            (arg: HWCheckResponse) => {
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
    }, []); // only run once

    return (
        <>
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
                        {errors.map((error, idx) => (
                            <Typography.Text key={idx} type="danger">
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
