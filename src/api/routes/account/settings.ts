import fp from 'fastify-plugin';
import { BnAccountSettings, defaultAccountSettings } from '../../../entity/BnAccountSettings';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/account/settings', {
    }, async (request, reply) => {
        if (!request.userAccount) {
            return reply.code(401).send();
        }

        let currSettings = await server.conn.getRepository(BnAccountSettings).findOne({
            where: {
                accountId: request.userAccount.bnAccountId,
            },
        });
        if (!currSettings) {
            currSettings = Object.assign(new BnAccountSettings(), defaultAccountSettings);
        }
        else {
            for (const key of Object.keys(defaultAccountSettings)) {
                if ((currSettings as any)[key] === null) {
                    (currSettings as any)[key] = (defaultAccountSettings as any)[key];
                }
            }
        }

        return reply.code(200).send(currSettings);
    });

    server.post<{
        Querystring: any,
        Params: any,
    }>('/account/settings', {
        schema: {
            body: {
                type: 'object',
                properties: {
                    profilePrivate: {
                        type: 'boolean',
                    },
                    mapPubDownload: {
                        type: 'boolean',
                    },
                    mapPrivDownload: {
                        type: 'boolean',
                    },
                    mapPrivDetails: {
                        type: 'boolean',
                    },
                    mapPrivListed: {
                        type: 'boolean',
                    },
                },
                additionalProperties: false,
            },
        },
    }, async (request, reply) => {
        if (!request.userAccount) {
            return reply.code(401).send();
        }

        let currSettings = await server.conn.getRepository(BnAccountSettings).findOne({
            where: {
                accountId: request.userAccount.bnAccountId,
            },
        });
        if (!currSettings) {
            currSettings = Object.assign(new BnAccountSettings(), defaultAccountSettings);
            Object.assign(currSettings, request.body);
            currSettings.accountId = request.userAccount.bnAccountId;
            await server.conn.getRepository(BnAccountSettings).insert(currSettings);
        }
        else {
            await server.conn.getRepository(BnAccountSettings).update(request.userAccount.bnAccountId, request.body);
        }

        return reply.code(200).send();
    });
});
