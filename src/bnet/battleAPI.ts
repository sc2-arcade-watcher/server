import * as qs from 'querystring';
import * as fs from 'fs-extra';
import * as http from 'http';
import * as https from 'https';
import Axios, { AxiosInstance, AxiosRequestConfig, AxiosResponse, AxiosTransformer } from 'axios';
import applyCaseMiddleware from 'axios-case-converter';
import * as snakecaseKeys from 'snakecase-keys';
import { GameRegionSite, regionSiteCode } from '../common';
import { isAxiosError, sleep, TypedEvent } from '../helpers';
import { logger } from '../logger';

export type BattleAPIGateway = '{region}.battle.net'
    | 'us.battle.net'
    | 'eu.battle.net'
    | 'kr.battle.net'
    | 'www.battlenet.com.cn'
    | '{region}.api.blizzard.com'
    | 'us.api.blizzard.com'
    | 'eu.api.blizzard.com'
    | 'kr.api.blizzard.com'
    | 'tw.api.blizzard.com'
    | 'gateway.battlenet.com.cn'
    | 'starcraft2.com/en-us/api'
;

export interface BattleAPIClientConfig {
    gateway?: {
        general?: BattleAPIGateway;
        oauth?: BattleAPIGateway;
        sc2?: BattleAPIGateway;
    };
    region?: GameRegionSite;
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
}

interface BattleAPIModuleConfig {
    client: BattleAPIClientConfig;
    axios: AxiosRequestConfig;
}

function gatewayURL(gateway: BattleAPIGateway, region: GameRegionSite) {
    return `https://${gateway.replace('{region}', regionSiteCode(region).toLowerCase())}`;
}

abstract class BattleAPIBase {
    protected mConfig: BattleAPIModuleConfig;
    readonly axios: AxiosInstance;

    constructor(params: Partial<BattleAPIModuleConfig> = {}) {
        this.mConfig = {
            client: Object.assign(<Partial<BattleAPIClientConfig>>{
                region: GameRegionSite.US,
                gateway: {},
            }, params?.client ?? {}),
            axios: params?.axios ?? {},
        };
        this.mConfig.client.gateway = Object.assign({
            general: '{region}.api.blizzard.com',
            oauth: 'us.battle.net',
            sc2: '{region}.api.blizzard.com',
        }, params.client?.gateway ?? {});

        this.axios = this.createAxios();
    }

    protected createAxios() {
        return Axios.create(Object.assign<AxiosRequestConfig, AxiosRequestConfig>({
            timeout: 40000,
            baseURL: gatewayURL(this.mConfig.client.gateway.general, this.mConfig.client.region),
            httpAgent: new http.Agent({
                keepAlive: true,
            }),
            httpsAgent: new https.Agent({
                keepAlive: true,
            }),
            headers: {
                'Accept-Encoding': 'gzip',
            },
        }, this.mConfig.axios ?? {}));
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

export class BattleOAuth extends BattleAPIBase {
    protected createAxios() {
        let customAxios = super.createAxios();
        customAxios.defaults.baseURL = `${gatewayURL(this.mConfig.client.gateway.oauth, this.mConfig.client.region)}/oauth`;
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

export interface BattleSC2ProfileBase {
    name: string;
    profileUrl: string;
    avatarUrl: string;
    profileId: number;
    regionId: number;
    realmId: number;
}

export interface BattleSC2ProfileSummary {
    id: string;
    realm: number;
    displayName: string;
    clanName?: string;
    clanTag?: string;
    portrait: string;
    decalTerran: string;
    decalProtoss: string;
    decalZerg: string;
    totalSwarmLevel: number;
    totalAchievementPoints: number;
}

export interface BattleSC2ProfileFull {
    summary: BattleSC2ProfileSummary;
}

export enum BattleSC2MatchDecision {
    Left = 'Left',
    Win = 'Win',
    Loss = 'Loss',
    Tie = 'Tie',
    Observer = 'Observer',
    Disagree = 'Disagree',
    Unknown = '(Unknown)',
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
    OneVersusOne = '1v1',
    TwoVersusTwo = '2v2',
    ThreeVersusThree = '3v3',
    FourVersusFour = '4v4',
    FreeForAll = 'FFA',
}

export interface BattleSC2MatchEntry {
    map: string;
    type: BattleSC2MatchType;
    decision: BattleSC2MatchDecision;
    speed: BattleSC2MatchSpeed;
    date: number;
}

export interface BattleSC2MatchHistory {
    matches: BattleSC2MatchEntry[];
}

function fixProfileId(data: any) {
    if (Array.isArray(data)) {
        data.forEach(x => {
            x.profileId = Number(x.profileId);
        });
    }
    else if (typeof data === 'object' && data.profileId) {
        data.profileId = Number(data.profileId);
    }
    return data;
}

class BattleSC2 extends BattleAPIBase {
    protected createAxios() {
        let customAxios = super.createAxios();
        Object.assign(customAxios.defaults, <AxiosRequestConfig>{
            baseURL: `${gatewayURL(this.mConfig.client.gateway.sc2, this.mConfig.client.region)}/sc2`,
        });
        if (this.mConfig.client.gateway.sc2 !== 'starcraft2.com/en-us/api' && this.mConfig.client.accessToken) {
            customAxios.defaults.headers['Authorization'] = `Bearer ${this.mConfig.client.accessToken}`;
        }
        return customAxios;
    }

    async getAccount(accountId: number) {
        return this.axios.get<BattleSC2ProfileBase[]>(`player/${accountId}`, {
            transformResponse: [].concat(
                this.axios.defaults.transformResponse,
                fixProfileId
            ),
        });
    }

    async getProfileSummary(params: BattleSC2ProfileParams) {
        return this.axios.get<BattleSC2ProfileFull>(`profile/${params.regionId}/${params.realmId}/${params.profileId}`);
    }

    async getProfileMeta(params: BattleSC2ProfileParams) {
        return this.axios.get<BattleSC2ProfileBase>(`metadata/profile/${params.regionId}/${params.realmId}/${params.profileId}`, {
            transformResponse: [].concat(
                this.axios.defaults.transformResponse,
                fixProfileId
            ),
        });
    }

    async getProfileMatchHistory(params: BattleSC2ProfileParams & { locale?: string }) {
        return this.axios.get<BattleSC2MatchHistory>(`legacy/profile/${params.regionId}/${params.realmId}/${params.profileId}/matches`, {
            params: {
                'locale': params?.locale ?? 'en_US',
            },
        });
    }
}

const defaultConfig: BattleAPIClientConfig = {
    clientId: process.env.STARC_BNET_API_CLIENT_ID,
    clientSecret: process.env.STARC_BNET_API_CLIENT_SECRET,
    accessToken: (function() {
        try {
            return fs.readFileSync('data/config/.battle_token', 'utf8');
        }
        catch (err) {
            return void 0;
        }
    })(),
};

let battleTokenRefreshEvent: TypedEvent<string> = void 0;

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

        this.sc2.axios.interceptors.response.use(function (response) {
            return response;
        }, async (error) => {
            if (isAxiosError(error)) {
                if ((error.config as any).retryAttempt && (error.config as any).retryAttempt > 4) {
                    logger.warn(`exceeded retry limit reqUrl=${error.config.url}`);
                    throw error;
                }
                (error.config as any).retryAttempt = ((error.config as any).retryAttempt ?? 0) + 1;

                if (error?.response?.status === 401) {
                    logger.warn(`Battle accessToken expired? reqUrl=${error.config.url}`);
                    const accessToken = await this.refreshToken();
                    if (!accessToken) {
                        throw error;
                    }
                    error.config.headers['Authorization'] = `Bearer ${accessToken}`;
                }
                else if (error?.response?.status === 429) {
                    await sleep(1800 * Math.pow((error.config as any).retryAttempt, 1.6));
                }
                else if (error?.response?.status === 503) {
                    await sleep(400 * Math.pow((error.config as any).retryAttempt, 1.3));
                }
                else if (error?.response?.status === 504) {
                    await sleep(300 * Math.pow((error.config as any).retryAttempt, 1.1));
                }
                else if (error?.code === 'ECONNRESET') {
                    logger.warn(`req failed due to ${error?.code}, retrying in..`);
                    await sleep(1000 * Math.pow((error.config as any).retryAttempt, 1.4));
                }
                else {
                    throw error;
                }
                return this.sc2.axios.request(error.config);
            }
            throw error;
        });
    }

    async refreshToken(): Promise<string | undefined> {
        if (battleTokenRefreshEvent) {
            return (new Promise((resolve, reject) => {
                battleTokenRefreshEvent.once((ev) => { resolve(ev); });
            }));
        }

        battleTokenRefreshEvent = new TypedEvent();
        try {
            logger.verbose(`Refreshing Battle token..`);
            const tokenInfo = (await this.oauth.acquireToken({ grantType: 'client_credentials' })).data;
            this.sc2.axios.defaults.headers['Authorization'] = `Bearer ${tokenInfo.accessToken}`;
            logger.verbose(`Refreshed Battle token, accessToken=${tokenInfo.accessToken} expiresIn=${tokenInfo.expiresIn}`);
            await fs.writeFile('data/config/.battle_token', tokenInfo.accessToken, { encoding: 'utf8' });
            battleTokenRefreshEvent.emit(tokenInfo.accessToken);
            return tokenInfo.accessToken;
        }
        catch (err) {
            logger.error(`Failed to refresh token`, err);
            battleTokenRefreshEvent.emit(void 0);
        }
        finally {
            battleTokenRefreshEvent = void 0;
        }
    }
}
