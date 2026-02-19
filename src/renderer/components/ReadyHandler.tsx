import { CheckCircleOutlined, WarningOutlined } from '@ant-design/icons';
import { Spin } from 'antd';

// TODO: eslint typescript bug. needs upgrade.
/* eslint-disable no-unused-vars, no-shadow */
export enum ReadyState {
    NotReady,
    Ready,
    Error,
}
/* eslint-disable no-unused-vars, no-shadow */

function ReadyHandler({ ready }: { ready: ReadyState }) {
    switch (ready) {
        case ReadyState.NotReady:
            return <Spin />;
        case ReadyState.Ready:
            return <CheckCircleOutlined />;
        case ReadyState.Error:
            return <WarningOutlined />;
        default:
            return null;
    }
}

export default ReadyHandler;
