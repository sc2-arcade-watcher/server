import { createHash } from 'crypto';
import * as orm from 'typeorm';
import fp from 'fastify-plugin';
import { AppAccountToken, AppAccountTokenKind } from '../../entity/AppAccountToken';
import { addSeconds } from 'date-fns';
import { logger } from '../../logger';
import { AppAccount } from '../../entity/AppAccount';
import { BattleOAuth, BattleAuthScope, BattleAuthResponse, BattleUserInfo, BattleErrorResponse } from '../../bnet/battleAPI';
import { isAxiosError } from '../../helpers';
import { BattleDataUpdater } from '../../bnet/battleData';

class AuthManager {
    protected tokenLengthInit = 14;
    protected tokenLengthExtension = 7;
    protected bData = new BattleDataUpdater(this.conn);

    constructor (protected conn: orm.Connection) {
    }

    async verifyToken(accessToken: string) {
        const appToken = await this.conn.getRepository(AppAccountToken).findOne({
            relations: [
                'account',
                'account.bnAccount',
            ],
            where: {
                type: AppAccountTokenKind.App,
                accessToken: accessToken,
            },
        });
        if (!appToken) {
            return false;
        }

        if (appToken.expiresAt !== null) {
            if ((new Date()) >= appToken.expiresAt) {
                return false;
            }
            // if (subDays(new Date(), this.tokenLengthExtension - 1) < appToken.expiresAt) {
            //     appToken.expiresAt = addDays(new Date(), this.tokenLengthExtension);
            //     await this.conn.getRepository(AppAccountToken).save(appToken);
            // }
        }

        return appToken;
    }

    async invalidateToken(userToken: AppAccountToken) {
        await this.conn.getRepository(AppAccountToken).delete(userToken);
    }

    async authViaBattle(authCode: string, redirectUri: string, clientInfo: { ip: string, userAgent: string }) {
        const bOAuthAPI = new BattleOAuth();

        let bAuthInfo: BattleAuthResponse;
        let bUserInfo: BattleUserInfo;

        try {
            bAuthInfo = (await bOAuthAPI.acquireToken({
                grantType: 'authorization_code',
                scope: BattleAuthScope.SC2Profile,
                redirectUri: redirectUri,
                code: authCode,
            })).data;
            bUserInfo = (await bOAuthAPI.userInfo(bAuthInfo.accessToken)).data;
        }
        catch (err) {
            if (isAxiosError(err)) {
                logger.warn(`battle auth failed, code=${authCode}`, err.request, err.response);
                const errorMessage = err.response.data as BattleErrorResponse;
                if (errorMessage.error && errorMessage.errorDescription) {
                    return errorMessage;
                }
                else {
                    throw err;
                }
            }
            else {
                throw err;
            }
        }

        let userAccount = await this.conn.getRepository(AppAccount).findOne({
            relations: [
                'bnAccount',
                'bnAccount.profileLinks',
            ],
            where: {
                bnAccountId: bUserInfo.id,
            },
        });
        await this.conn.getRepository(AppAccountToken).delete({
            type: AppAccountTokenKind.Bnet,
            accessToken: bAuthInfo.accessToken,
        });

        if (!userAccount) {
            userAccount = new AppAccount();
            userAccount.createdAt = new Date();
        }
        userAccount.bnAccount = await this.bData.updateAccount(bUserInfo);
        userAccount.lastLoginAt = new Date();
        await this.conn.getRepository(AppAccount).save(userAccount, { transaction: false });

        // battle.net token
        const bToken = new AppAccountToken();
        bToken.createdAt = new Date();
        bToken.account = userAccount;
        bToken.type = AppAccountTokenKind.Bnet;
        bToken.expiresAt = addSeconds(new Date(), bAuthInfo.expiresIn);
        bToken.accessToken = bAuthInfo.accessToken;
        await this.conn.getRepository(AppAccountToken).insert(bToken);

        // app token
        const appToken = new AppAccountToken();
        appToken.createdAt = new Date();
        appToken.account = userAccount;
        appToken.type = AppAccountTokenKind.App;
        appToken.userIp = clientInfo.ip;
        appToken.userAgent = clientInfo.userAgent.substr(0, 255);
        // appToken.expiresAt = addDays(new Date(), this.tokenLengthInit);
        appToken.accessToken = createHash('sha256').update(JSON.stringify([
            appToken.account.id,
            (new Date()).getTime(),
            appToken.expiresAt,
            process.env.STARC_APP_SECRET
        ])).digest('hex');
        await this.conn.getRepository(AppAccountToken).insert(appToken);

        return appToken;
    }
}

declare module 'fastify' {
    export interface FastifyInstance {
        authManager: AuthManager;
    }
}

declare module 'fastify' {
    interface FastifyRequest {
        userToken?: AppAccountToken | null;
        userAccount?: AppAccount | null;
    }
}

export default fp(async (server, opts) => {
    server.decorate('authManager', new AuthManager(server.conn));

    server.addHook('preHandler', async (request, reply) => {
        if (request.raw.url.startsWith('/depot/')) return;

        const authorization = request.headers['authorization'] as string;
        if (authorization && authorization.startsWith('Bearer ')) {
            const accessToken = authorization.substr('Bearer '.length);
            const appToken = await server.authManager.verifyToken(accessToken);
            if (appToken) {
                request.userToken = appToken;
                request.userAccount = appToken.account;
            }
        }
    });
});
