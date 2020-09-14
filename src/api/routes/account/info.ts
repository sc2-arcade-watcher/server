import * as fp from 'fastify-plugin';

export default fp(async (server, opts, next) => {
    server.get('/account/info', {
    }, async (request, reply) => {
        if (!request.userAccount) {
            return reply.code(401).send();
        }

        return reply.code(200).send({
            battleAccount: request.userAccount.bnAccount,
        });
    });
});
