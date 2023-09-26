import { CheckCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { Col, Row, Space, Spin, Typography } from "antd";
import HWCheckResponse from "models/HWCheckResponse";
import { Steppable } from "models/steppable";
import { useEffect, useState } from "react";
import StepBar from "renderer/components/StepBar";
import AVTotes from "../../../../assets/photos/av_totes.png"
import CameraPelicans from "../../../../assets/photos/camera_pelicans.jpg"

enum ReadyState {
    NotReady,
    Ready,
    Error
}

const HWCheck = ({ nextStep, previousStep }: Steppable) => {

    const [networkReady, setNetworkReady] = useState(ReadyState.NotReady);
    const [ipReady, setIpReady] = useState(ReadyState.NotReady);
    const [audioReady, setAudioReady] = useState(ReadyState.NotReady);
    const [errors, setErrors] = useState<string[]>([]);

    useEffect(() => {
        // Fire off HW check and register listener
        window.electron.ipcRenderer.once<HWCheckResponse>('hwcheck-response', (arg: HWCheckResponse) => {
            setNetworkReady(arg.av_ip_ready && arg.field_ip_ready && arg.venue_ip_ready ? ReadyState.Ready : ReadyState.Error);
            setIpReady(arg.nics_found.length > 3 ? ReadyState.Ready : ReadyState.Error);
            setAudioReady(arg.audio_ready ? ReadyState.Ready : ReadyState.Error);
            setErrors(arg.errors);
        });
        window.electron.ipcRenderer.sendMessage('hwcheck', []);
    }, []); // only run once

    const ReadyHandeler = ({ ready }: { ready: ReadyState }) => {
        switch (ready) {
            case ReadyState.NotReady:
                return <Spin />;
            case ReadyState.Ready:
                return <CheckCircleOutlined />;
            case ReadyState.Error:
                return <WarningOutlined />;
        }
    }

    const ready = () => networkReady === ReadyState.Ready && ipReady === ReadyState.Ready && audioReady === ReadyState.Ready

    return (
        <>
            <Space direction="vertical" style={{ textAlign: "center", width: "100%" }}>
                <Typography.Title level={1}>Hardware Self-Check</Typography.Title>
                <Typography.Title level={5}>Hang tight... We're checking to make sure that your AV computer is ready for this event!</Typography.Title>
                <Typography.Text><ReadyHandeler ready={networkReady} />  Network Adapters</Typography.Text>
                <Typography.Text><ReadyHandeler ready={ipReady} /> IP Addresses</Typography.Text>
                <Typography.Text><ReadyHandeler ready={audioReady} /> Audio Devices</Typography.Text>

                {errors && errors.length > 0 && 
                    <>
                    
                        <Typography.Text>Don't worry about any errors below. We'll help you get these resolved soon!</Typography.Text>
                        {errors.map(error => <Typography.Text type="danger">{error}</Typography.Text>)}
                    </>
                }

                {/* Meanwhile, locate your AV Totes */}
                <Typography.Title level={3}>Meanwhile, please locate your 2 AV Totes and 2 small camera pelicans. They are pictured below.</Typography.Title>

                <Row>
                    <Col span={12}>
                        <img src={AVTotes} style={{ width: "80%" }} />
                    </Col>
                    <Col span={12}>
                        <img src={CameraPelicans} style={{ width: "80%" }} />
                    </Col>
                </Row>
            </Space>

            <StepBar nextStep={nextStep} previousStep={previousStep} showNext showPrev nextDisabled={!ready()} />
        </>
    )
};

export default HWCheck;