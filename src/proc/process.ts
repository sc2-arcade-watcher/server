import { TypedEvent } from '../helpers';
import { logger } from '../logger';

export abstract class ServiceProcess {
    protected isShuttingDown: boolean = true;
    protected _onDoneEvent: TypedEvent<void>;

    protected abstract async doStart(): Promise<void>;
    protected abstract async doShutdown(): Promise<void>;

    protected getName() {
        return `${this.constructor.name}`;
    }

    async shutdown() {
        if (this.isShuttingDown) return;
        this.isShuttingDown = true;
        logger.info(`Stopping ${this.getName()}`);
        await this.doShutdown();
        logger.info(`Stopped ${this.getName()}`);
        this._onDoneEvent.emit();
        this._onDoneEvent = void 0;
    }

    async start() {
        if (this._onDoneEvent) return;
        this.isShuttingDown = false;
        this._onDoneEvent = new TypedEvent();
        await this.doStart();
    }

    async onDone() {
        if (!this._onDoneEvent) return;
        return new Promise((resolve, reject) => this._onDoneEvent.once(resolve));
    }
}
