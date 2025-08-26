export type LogLevel = 'debug' | 'info' | 'warn' | 'error';


const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };


function safeSerialize(meta: any) {
    try {
        if (meta instanceof Error) {
            return { name: meta.name, message: meta.message, stack: meta.stack };
        }
        return JSON.parse(
            JSON.stringify(meta, (_k, v) => {
                if (v instanceof Set) return Array.from(v);
                if (v instanceof Map) return Object.fromEntries(v);
                if (typeof v === 'bigint') return v.toString();
                if (v instanceof Error) return { name: v.name, message: v.message, stack: v.stack };
                return v;
            })
        );
    } catch {
        return { value: String(meta) };
    }
}


export class Logger {
    constructor(private level: LogLevel = (process.env.LOG_LEVEL as LogLevel) || 'info', private name = 'scraper') { }


    private should(level: LogLevel) {
        return LEVEL_ORDER[level] >= LEVEL_ORDER[this.level];
    }


    private line(level: LogLevel, msg: string, meta?: unknown) {
        const payload: any = {
            ts: new Date().toISOString(),
            level,
            name: this.name,
            msg,
        };
        if (meta !== undefined) payload.meta = safeSerialize(meta);
        return JSON.stringify(payload);
    }


    debug(msg: string, meta?: unknown) {
        if (this.should('debug')) console.debug(this.line('debug', msg, meta));
    }
    info(msg: string, meta?: unknown) {
        if (this.should('info')) console.log(this.line('info', msg, meta));
    }
    warn(msg: string, meta?: unknown) {
        if (this.should('warn')) console.warn(this.line('warn', msg, meta));
    }
    error(msg: string, meta?: unknown) {
        if (this.should('error')) console.error(this.line('error', msg, meta));
    }


    child(bindings: Partial<{ name: string; level: LogLevel }>) {
        return new Logger(bindings.level ?? this.level, bindings.name ?? this.name);
    }
}