import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs-extra';
import * as os from 'os';
import { spawn } from 'child_process';
import axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse } from 'axios';
import { execAsync, spawnWaitExit, SpawnWaitResult } from './helpers';
import { logger } from './logger';

export class NestedHashDir {
    constructor (public readonly rootPath: string) {
    }

    pathTo(name: string) {
        const ext = path.extname(name);
        const base = path.basename(name, ext);
        if (base.length < 4) {
            return path.join(this.rootPath, base + ext);
        }
        return path.join(this.rootPath, base.substr(0, 2), base.substr(2, 2), base + ext);
    }

    async ensurePathTo(name: string) {
        const result = this.pathTo(name);
        await fs.ensureDir(path.dirname(result));
        return result;
    }
}

function getDepotURL(region: string, filename?: string) {
    if (region.toLowerCase() === 'cn') {
        return `http://${region.toLowerCase()}.depot.battlenet.com.cn:1119/${filename ?? ''}`;
    }
    else {
        return `http://${region.toLowerCase()}.depot.battle.net:1119/${filename ?? ''}`;
    }
}

export class BattleDepot {
    readonly ndir: NestedHashDir;

    constructor (rootPath: string) {
        this.ndir = new NestedHashDir(rootPath);
    }

    protected async download(region: string, filename: string, targetFilename: string) {
        await fs.ensureDir(path.dirname(targetFilename));
        const wgetProc = spawn('wget', [
            '-q',
            '-O', targetFilename,
            getDepotURL(region, filename),
        ]);
        const result = await spawnWaitExit(wgetProc);
        if (result.rcode !== 0) {
            throw new Error(`Failed to download "${filename}" rcode=${result.rcode}`);
        }
    }

    async retrieveHead(region: string, filename: string) {
        return axios.head(getDepotURL(region, filename));
    }

    async getPathOrRetrieve(region: string, filename: string) {
        const targetFilename = this.ndir.pathTo(filename);

        if (!(await fs.pathExists(targetFilename))) {
            const tmpFilename = path.join(os.tmpdir(), `${filename}.${Math.floor(Math.random() * 0x7FFFFFFF).toString(16)}`);
            await this.download(region, filename, tmpFilename);
            await fs.move(tmpFilename, targetFilename, { overwrite: true });
        }

        return targetFilename;
    }

    async readFile(region: string, filename: string) {
        const targetFilename = this.ndir.pathTo(filename);

        if ((await fs.pathExists(targetFilename))) {
            return fs.readFile(targetFilename, { encoding: 'utf8' });
        }

        return (await axios.get(getDepotURL(region, filename), {
            responseType: 'text',
        })).data as string;
    }
}

export interface ImagickConvertOptions {
}

export async function convertImage(src: string, dst: string, options: string[] = []) {
    let srcFormat = 'tga';
    const identifyProc = spawn('identify', [
        '-format', '%m',
        src,
    ]);
    const identifyResult = await spawnWaitExit(identifyProc, { captureStdout: true });
    if (identifyResult.rcode !== 0) {
        logger.warn(`Failed to identify image "${src}" rcode=${identifyResult.rcode}`);
    }
    else {
        srcFormat = identifyResult.stdout!.toLowerCase();
    }

    await fs.ensureDir(path.dirname(dst));
    const convertProc = spawn('convert', [
        `${srcFormat}:${src}`,
        ...options,
        dst,
    ]);

    const convertResult = await spawnWaitExit(convertProc);
    if (convertResult.rcode !== 0) {
        throw new Error(`Failed to convert image "${src}" rcode=${convertResult.rcode}`);
    }
}
