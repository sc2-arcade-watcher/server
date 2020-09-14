import * as fp from 'fastify-plugin';

export default fp(async (server, opts, next) => {
    server.get('/account/logout', {
    }, async (request, reply) => {
        if (!request.userAccount) {
            return reply.code(401).send();
        }

        await server.authManager.invalidateToken(request.userToken);

        return reply.code(200).send();
    });
});
