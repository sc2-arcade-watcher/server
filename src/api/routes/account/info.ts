import fp from 'fastify-plugin';
import { S2ProfileRepository } from '../../../repository/S2ProfileRepository';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/account/info', {
    }, async (request, reply) => {
        if (!request.userAccount) {
            return reply.code(401).send();
        }

        const accProfiles = await server.conn.getCustomRepository(S2ProfileRepository).findByBattleAccount(request.userAccount.bnAccount.id);

        return reply.code(200).send({
            battleAccount: {
                id: request.userAccount.bnAccount.id,
                battleTag: request.userAccount.bnAccount.battleTag,
                profiles: accProfiles,
            },
        });
    });
});
