import HWPingResponse from "models/HWPingResponse";
import React, { createContext } from "react";

export interface StatusContextType {
    auto_av_log: string | null;
    hw_stats: HWPingResponse
}

// eslint-disable-next-line no-unused-vars
const StatusContext = createContext<{ status: StatusContextType, setStatus: React.Dispatch<React.SetStateAction<StatusContextType>> }>(
    {
        status: {
            auto_av_log: null,
            hw_stats: {
                camera1: false,
                camera2: false,
                mixer: false,
                switch: false,
                internet: false,
                errors: []
            }
        },
        setStatus: () => {}
    }
);


export default StatusContext;