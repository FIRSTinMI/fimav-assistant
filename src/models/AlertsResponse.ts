export default interface AlertsResponse {
    alerts: {
        id: string,
        content: string // HTML
    }[]
}