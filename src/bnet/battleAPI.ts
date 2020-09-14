import * as qs from 'querystring';
import Axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosTransformer } from 'axios';
import applyCaseMiddleware from 'axios-case-converter';
import * as snakecaseKeys from 'snakecase-keys';
import { GameRegion, regionCode } from '../common';

export interface BattleAPIClientConfig {
    region: GameRegion;
    clientId: string;
    clientSecret: string;
}

interface BattleAPIModuleConfig {
    client: BattleAPIClientConfig;
    axios: AxiosRequestConfig;
}

abstract class BattleAPIBase {
    protected axios: AxiosInstance;

    constructor(protected readonly config: BattleAPIModuleConfig) {
        this.axios = this.createAxios();
    }

    protected createAxios() {
        return Axios.create(Object.assign({
            baseURL: `https://${regionCode(this.config.client.region).toLowerCase()}.api.blizzard.com`,
        }, this.config.axios));
    }

    protected encodeParams(params: qs.ParsedUrlQueryInput) {
        return qs.encode(snakecaseKeys(params));
    }
}

export interface BattleErrorResponse {
    error: string;
    errorDescription: string;
}

export type BattleGrantType = 'authorization_code' | 'client_credentials';

export enum BattleAuthScope {
    SC2Profile = 'sc2.profile',
}

export interface BattleAuthCodeBase {
    grantType: BattleGrantType;
    scope?: BattleAuthScope | BattleAuthScope[];
}

export interface BattleAuthCodeParams extends BattleAuthCodeBase {
    grantType: 'authorization_code';
    redirectUri: string;
    code: string;
}

export interface BattleAuthClientParams extends BattleAuthCodeBase {
    grantType: 'client_credentials';
}

export interface BattleAuthResponse {
    accessToken: string;
    tokenType: 'bearer';
    expiresIn: number;
    // this should actually be array, transformed from space delimeted string on axios side
    // but we only care about sc2.profile
    scope?: BattleAuthScope;
}

export interface BattleTokenStatus {
    authorities: string[];
    clientId: string;
    exp: number;
    // this should actually be array, transformed from space delimeted string on axios side
    // but we only care about sc2.profile
    scope?: BattleAuthScope;
    userName: string;
}

export interface BattleUserInfo {
    id: number;
    battletag: string;
    sub: string;
}

class BattleOAuth extends BattleAPIBase {
    protected createAxios() {
        let customAxios = super.createAxios();
        customAxios.defaults.baseURL = `https://${regionCode(this.config.client.region).toLowerCase()}.battle.net/oauth`;
        customAxios = applyCaseMiddleware(customAxios, {
            ignoreHeaders: true,
        });
        return customAxios;
    }

    async acquireToken(params: BattleAuthCodeParams | BattleAuthClientParams) {
        const transformedParams = {
            ...params,
            scope: typeof params.scope === 'string' ? params.scope : params.scope?.join(' ')
        };
        return this.axios.post<BattleAuthResponse>('token', this.encodeParams(transformedParams), {
            auth: {
                username: process.env.STARC_BNET_API_CLIENT_ID,
                password: process.env.STARC_BNET_API_CLIENT_SECRET,
            },
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });
    }

    async checkToken(accessToken: string) {
        return this.axios.post<BattleTokenStatus>('check_token', qs.encode({
            token: accessToken,
        }), {
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            },
        });
    }

    async userInfo(accessToken: string) {
        return this.axios.get<BattleUserInfo>('userinfo', {
            headers: {
                'Authorization': `Bearer ${accessToken}`,
            },
        });
    }
}

interface BattleSC2ProfileParams {
    profileId: number;
    regionId: number;
    realmId: number;
}

export interface BattleSC2Profile {
    name: string;
    profileUrl: string;
    avatarUrl: string;
    profileId: number;
    regionId: number;
    realmId: number;
}

export enum BattleSC2Decision {
    Left = 'Left',
    Win = 'Win',
    Loss = 'Loss',
}

export enum BattleSC2MatchSpeed {
    Slower = 'Slower',
    Slow = 'Slow',
    Normal = 'Normal',
    Fast = 'Fast',
    Faster = 'Faster',
}

export enum BattleSC2MatchType {
    Custom = 'Custom',
    Unknown = '(Unknown)',
    Coop = 'Co-op',
}

export interface BattleSC2MatchEntry {
    map: string;
    type: BattleSC2MatchType;
    decision: BattleSC2Decision;
    speed: BattleSC2MatchSpeed;
    date: number;
}

export interface BattleSC2MatchHistory {
    matches: BattleSC2MatchEntry[];
}

class BattleSC2 extends BattleAPIBase {
    protected createAxios() {
        let customAxios = super.createAxios();
        Object.assign(customAxios.defaults, <AxiosRequestConfig>{
            baseURL: `https://${regionCode(this.config.client.region).toLowerCase()}.api.blizzard.com/sc2`,
            headers: {
                'Authorization': `Bearer ${'USh4cFd9D37u4h26ntoDP4AT7ZBShYHrPT'}`,
            }
        });
        return customAxios;
    }

    async getAccount(accountId: number) {
        function fixProfileId(data: any) {
            if (Array.isArray(data)) {
                data.forEach(x => {
                    x.profileId = Number(x.profileId);
                });
            }
            return data;
        }

        return this.axios.get<BattleSC2Profile[]>(`player/${accountId}`, {
            transformResponse: [].concat(
                this.axios.defaults.transformResponse,
                fixProfileId
            ),
        });
    }

    async getMatchHistory(params: BattleSC2ProfileParams) {
        return this.axios.get<BattleSC2Profile[]>(`legacy/profile/${params.regionId}/${params.realmId}/${params.profileId}/matches`);
    }
}

const defaultConfig: BattleAPIClientConfig = {
    region: GameRegion.EU,
    clientId: process.env.STARC_BNET_API_CLIENT_ID,
    clientSecret: process.env.STARC_BNET_API_CLIENT_SECRET,
};

export class BattleAPI {
    public readonly oauth: BattleOAuth;
    public readonly sc2: BattleSC2;

    constructor(config: Partial<BattleAPIClientConfig> = {}) {
        const modConfig: BattleAPIModuleConfig = {
            client: { ...config, ...defaultConfig },
            axios: {
            },
        };
        this.oauth = new BattleOAuth(modConfig);
        this.sc2 = new BattleSC2(modConfig);
    }
}
