import { CheckCircleOutlined, WarningOutlined } from "@ant-design/icons";
import { Spin } from "antd";


export enum ReadyState {
    NotReady,
    Ready,
    Error
}

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

export default ReadyHandeler;