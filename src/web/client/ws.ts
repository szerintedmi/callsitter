/** WebSocket URL for a path on this server (wss on https pages). */
export const wsUrl = (path: string) => (location.protocol === "https:" ? "wss://" : "ws://") + location.host + path;
