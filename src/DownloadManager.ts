import { logger } from './Logger';

import cliProgress from 'cli-progress';
import WebSocket from 'ws';


export class DownloadManager {
    private webSocket: WebSocket;
    // TODO: there's a "not a tty" mode for progresBar
    // NOTE: is there a way to fix the ETA? Can't get size nor ETA from aria that I can see
    // we initialize this for each download
    private progresBar!: cliProgress.Bar;
    private completed: number;
    private queue: Set<string>;
    private index: number;

    public constructor(port: number) {
        this.webSocket = new WebSocket(`http://localhost:${port}/jsonrpc`);
        this.completed = 0;
        this.queue = new Set<string>();
        this.index = 1;

        if (!process.stdout.columns) {
            logger.warn(
                'Unable to get number of columns from terminal.\n' +
                'This happens sometimes in Cygwin/MSYS.\n' +
                'No progress bar can be rendered, however the download process should not be affected.\n\n' +
                'Please use PowerShell or cmd.exe to run destreamer on Windows.'
            );
        }

        this.webSocket.on('message', (data: WebSocket.Data) => {
            const parsed = JSON.parse(data.toString());

            // print only messaged not handled during download
            // NOTE: maybe we could remove this and re-add when the downloads are done
            if (parsed.method !== 'aria2.onDownloadComplete' &&
                parsed.method !== 'aria2.onDownloadStart' &&
                parsed.id !== 'getSpeed' &&
                parsed.id !== 'addUrl' &&
                parsed.id !== 'shutdown') {
                logger.info('[INCOMING] \n' + JSON.stringify(parsed, null, 4) + '\n\n');
            }
        });
    }

    /**
     * MUST BE CALLED BEFORE ANY OTHER OPERATION
     *
     * Wait for an established connection between the webSocket
     * and Aria2c with a 10s timeout.
     * Then send aria2c the global config option if specified.
     */
    public async init(options?: {[option: string]: string}): Promise<void> {
        let tries = 0;
        const waitSec = 10;

        while (this.webSocket.readyState !== this.webSocket.OPEN) {
            if (tries < waitSec) {
                tries++;
                logger.debug(`[DownloadMangaer] Trying to connect to aria deamon ${tries}/${waitSec}`);
                await new Promise(r => setTimeout(r, 1000));
            }
            else {
                throw new Error();
            }
        }
        logger.info('Connected! \n');

        if (options) {
            logger.info('Now trying to send configs...');
            this.setOptions(options);
        }
    }

    public async close(): Promise<void> {
        let exited = false;
        let tries = 0;
        const waitSec = 10;

        this.webSocket.on('message', (data: WebSocket.Data) => {
            const parsed = JSON.parse(data.toString());

            if (parsed.result === 'OK') {
                exited = true;
                logger.verbose('Aria2c shutdown complete');
            }
        });

        this.webSocket.send(this.createMessage('aria2.shutdown', null, 'shutdown'));
        this.webSocket.close();

        while ((this.webSocket.readyState !== this.webSocket.CLOSED) || !exited) {
            if (tries < waitSec) {
                tries++;
                await new Promise(r => setTimeout(r, 1000));
            }
            else {
                throw new Error();
            }
        }
    }

    private initProgresBar(): void {
        this.progresBar = new cliProgress.SingleBar({
            barCompleteChar: '\u2588',
            barIncompleteChar: '\u2591',
            format: 'progress [{bar}] {percentage}%   {speed} MB/s   {eta_formatted}',
            // process.stdout.columns may return undefined in some terminals (Cygwin/MSYS)
            barsize: Math.floor((process.stdout.columns || 30) / 3),
            stopOnComplete: true,
            hideCursor: true,
        });
    }

    private createMessage(method: 'aria2.addUri', params: [[string]] | [[string], object], id?: string): string;
    private createMessage(method: 'aria2.getUris', params: [string], id?: string): string;
    private createMessage(method: 'aria2.changeOption', params: [string, object], id?: string): string;
    private createMessage(method: 'aria2.changeGlobalOption', params: [{[option: string]: string}], id?: string): string;
    private createMessage(method: 'system.multicall', params: [Array<object>], id?: string): string;
    // FIXME: I don't know how to properly implement this one that doesn't require params..
    private createMessage(method: 'aria2.getGlobalStat', params?: null, id?: string): string;
    private createMessage(method: 'aria2.shutdown', params?: null, id?: string): string;
    private createMessage(method: string, params?: any, id?: string): string {
        return JSON.stringify({
            jsonrpc: '2.0',
            id: id ?? 'Destreamer',
            method: method,
            // This took 40 mins just because I didn't want to use an if...so smart -_-
            ...(!!params && {params: params})
        });
    }

    private createMulticallElement(method: string, params?: any): any {
        return {
            methodName: method,
            // This took 40 mins just because I didn't want to use an if...so smart -_-
            ...(!!params && {params: params})
        };
    }

    /**
     * For general options see
     * {@link https://aria2.github.io/manual/en/html/aria2c.html#aria2.changeOption here}.
     * For single download options see
     * {@link https://aria2.github.io/manual/en/html/aria2c.html#aria2.changeGlobalOption here}
     *
     * @param options object with key: value pairs
     */
    private setOptions(options: {[option: string]: string}, guid?: string): void {
        const message: string = guid ?
            this.createMessage('aria2.changeOption', [guid, options]) :
            this.createMessage('aria2.changeGlobalOption', [options]);

        this.webSocket.send(message);
    }

    public downloadUrls(urls: Array<string>, directory: string): Promise<void> {
        return new Promise (resolve => {

            this.index = 1;
            this.completed = 0;
            // initialize the bar as a new one
            this.initProgresBar();
            let barStarted = false;

            const handleResponse = (data: WebSocket.Data): void => {
                const parsed = JSON.parse(data.toString());

                /* I ordered them in order of (probable) times called so
                that we don't check useless ifs (even if we aren't caring about efficency) */

                // handle download completions
                if (parsed.method === 'aria2.onDownloadComplete') {
                    this.queue.delete(parsed.params.pop().gid.toString());
                    this.progresBar.update(++this.completed);

                    /* NOTE: probably we could use setIntervall because reling on
                    a completed download is good in most cases (since the segments
                    are small and a lot, somany and frequent updates) BUT if the user
                    internet speed is really low the completed downalods come in
                    less frequently and we have less updates */
                    this.webSocket.send(this.createMessage('aria2.getGlobalStat', null, 'getSpeed'));

                    if (this.queue.size === 0) {
                        this.webSocket.removeListener('message', handleResponse);
                        resolve();
                    }
                }

                // handle speed update packages
                else if (parsed.id === 'getSpeed') {
                    this.progresBar.update(this.completed,
                        { speed: ((parsed.result.downloadSpeed as number) / 1000000).toFixed(2) });
                }

                // handle download errors
                else if (parsed.method === 'aria2.onDownloadError') {
                    // TODO: test download error parsing, not had a chance to yet
                    logger.error(JSON.stringify(parsed));

                    const errorGid: string = parsed.params.pop().gid.toString();
                    this.queue.delete(errorGid);

                    this.webSocket.send(this.createMessage('aria2.getUris', [errorGid], 'getUrlForRetry'));
                }

                // TODO: handle download retries
                else if (parsed.id === 'getUrlForRetry') {
                    logger.error('RECIVED URL TO RETRY, NOT IMPLEMENTED YET');
                    logger.error(JSON.stringify(parsed, null, 4));
                }

                // handle url added to download list in aria
                else if (parsed.id === 'addUrl') {
                    // if we recive array it's the starting list of downloads
                    // if it's a single string it's an error download being re-added
                    if (typeof parsed.result === 'string') {
                        this.queue.add(parsed.result.gid.toString());
                    }
                    else if (Array.isArray(parsed.result)) {
                        parsed.result.forEach((gid: string) =>
                            this.queue.add(gid.toString())
                        );

                        if (!barStarted) {
                            barStarted = true;
                            logger.debug(`[DownloadMangaer] Starting queue size: ${this.queue.size}`);
                            this.progresBar.start(this.queue.size, 0, { speed: 0});
                        }
                    }
                }
            };

            this.webSocket.on('message', data => handleResponse(data));

            const paramsForDownload: Array<any> = urls.map(url => {
                const title: string = (this.index++).toString().padStart(16, '0') + '.encr';

                return this.createMulticallElement(
                    'aria2.addUri', [[url], {out: title, dir: directory}]);
            });

            this.webSocket.send(
                this.createMessage('system.multicall', [paramsForDownload], 'addUrl')
            );
        });
    }
}
