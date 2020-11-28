import fp from 'fastify-plugin';
import { AppAccountToken } from '../../../../entity/AppAccountToken';

export default fp(async (server, opts) => {
    server.post<{
        Body: any,
        Querystring: any,
        Params: any,
    }>('/account/auth/bnet', {
        schema: {
            body: {
                type: 'object',
                required: ['redirectUri', 'code'],
                properties: {
                    redirectUri: {
                        type: 'string',
                    },
                    code: {
                        type: 'string',
                    },
                },
            },
        },
    }, async (request, reply) => {
        try {
            const redirectURL = new URL(request.body.redirectUri);
            const whitelist = process.env.STARC_WEBAPI_HOSTNAME_WHITELIST.split(' ');
            if (!whitelist.find(x => x === redirectURL.hostname)) {
                return reply.code(400).send({
                    message: `Unknown hostname in redirect URI`,
                });
            }
        }
        catch (err) {
            return reply.code(400).send({
                message: `Invalid redirect URI`,
            });
        }

        const authResult = await server.authManager.authViaBattle(request.body.code, request.body.redirectUri, {
            ip: request.ip,
            userAgent: request.headers['user-agent'],
        });
        if (!(authResult instanceof AppAccountToken)) {
            if (authResult.error === 'invalid_grant') {
                return reply.code(400).send({
                    message: authResult.errorDescription,
                });
            }
            else {
                return reply.code(503).send({
                    message: authResult.errorDescription,
                });
            }
        }

        return reply.code(200).send({
            accessToken: authResult.accessToken,
            battleAccount: authResult.account.bnAccount,
        });
    });
});
