import * as util from 'util';
import * as path from 'path';
import * as fs from 'fs-extra';
import { spawn } from 'child_process';
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
            `http://${region.toLowerCase()}.depot.battle.net:1119/${filename}`,
        ]);
        const result = await spawnWaitExit(wgetProc);
        if (result.rcode !== 0) {
            throw new Error(`Failed to download "${filename}" rcode=${result.rcode}`);
        }
    }

    async getPathOrRetrieve(region: string, filename: string) {
        const targetFilename = this.ndir.pathTo(filename);

        if (!(await fs.pathExists(targetFilename))) {
            await this.download(region, filename, targetFilename);
        }

        return targetFilename;
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
        logger.error(`Failed to identify image "${src}" rcode=${identifyResult.rcode}`);
    }
    else {
        srcFormat = identifyResult.stdout.toLowerCase();
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
