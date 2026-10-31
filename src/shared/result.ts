// What main answers when the person asked for something it declined or could not do. A thrown refusal would reach
// the renderer wrapped in Electron's `Error invoking remote method`.
export type Result<T = object> = ({ ok: true } & T) | { ok: false; error: { code: string; message: string; retryable: boolean } };
