import { Space, Typography } from "antd";
import { useContext } from "react";
import StatusContext from "renderer/hooks/status_state";


export default function AppFooter() {
    const { status } = useContext(StatusContext);

    return (

        <Space direction='horizontal' size='large' style={{ width: '100%', position: 'absolute', bottom: 0, left: 0, borderTop: '1px solid #e8e8e8', padding: '5px 0', margin: '0px, 5px' }}>
            {status.auto_av_log && (
                <Typography.Text style={{margin: '0px 5px'}}>
                    AutoAV: {status.auto_av_log}
                </Typography.Text>
            )}

            {!status.auto_av_log && (
                <Typography.Text style={{margin: '0px 5px'}}>
                    AutoAV Status Unknown
                </Typography.Text>
            )}
        </Space>
    )
}