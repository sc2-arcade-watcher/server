import * as fp from 'fastify-plugin';
import { stripIndents } from 'common-tags';
import { S2GameLobby } from '../../../entity/S2GameLobby';
import { GameLobbyStatus } from '../../../gametracker';

export default fp(async (server, opts, next) => {
    server.get('/lobbies/active', {
        schema: {
            tags: ['Lobbies'],
            summary: 'Open and recently closed lobbies',
            description: stripIndents`
                List of active lobbies on the battle.net. In addition to \`open\` lobbies it also includes those which have been closed in the last 20 seconds.

                Important notices:

                - Timestamps are in UTC, given in ISO format with \`.3\` precision.

                - Slot info associated with the lobby might not be immediately available, in which case an empty array will be returned.

                - Amount of slots can change on very rare occasions. I've noticed this to happen in melee games specifically.

                - It's possible to have a human slot without \`profile\` linked (in which case it'll be \`null\`). It very rarely happens but you need to take it into account.

                - Maximum amount of slots is 16. But only 15 can be occupied by either human or an AI. There's at least one map on the Battle.net with 16 slots open, which shouldn't be possible, as SC2 is limited to 15 players. But the slot still appears as open.

                - Property \`slotsUpdatedAt\` indicates when the \`slots\` data has changed the last time - not when it was "checked" by the sc2 bot last time. Thus if no player join or leave it will remain the same.

                - Sometimes lobby might be flagged as started and then re-appear as open again, and it's not a bug. I believe it happens when status of the lobby becomes locked on the Battle.net - when its starting counter goes down to 3 (?). Then if player forcefully leaves, the game won't start and lobby will again appear on the list as \`open\`
            `,
        },
    }, async (request, reply) => {
        const qb = server.conn.getRepository(S2GameLobby)
            .createQueryBuilder('lobby')
            .select([
                'lobby.regionId',
                'lobby.bnetBucketId',
                'lobby.bnetRecordId',
                'lobby.mapBnetId',
                'lobby.mapMajorVersion',
                'lobby.mapMinorVersion',
                'lobby.extModBnetId',
                'lobby.extModMajorVersion',
                'lobby.extModMinorVersion',
                'lobby.multiModBnetId',
                'lobby.multiModMajorVersion',
                'lobby.multiModMinorVersion',
                'lobby.createdAt',
                'lobby.closedAt',
                'lobby.status',
                'lobby.mapVariantIndex',
                'lobby.mapVariantMode',
                'lobby.lobbyTitle',
                'lobby.hostName',
                'lobby.slotsUpdatedAt',
            ])
            // map info
            .innerJoinAndSelect('lobby.mapDocumentVersion', 'mapDocVer')
            .innerJoinAndSelect('mapDocVer.document', 'mapDoc')
            // ext mod info
            .leftJoinAndSelect('lobby.extModDocumentVersion', 'extModDocVer')
            .leftJoinAndSelect('extModDocVer.document', 'extModDoc')
            // slots
            .leftJoin('lobby.slots', 'slot')
            .addSelect([
                'slot.slotNumber',
                'slot.team',
                'slot.kind',
                'slot.name',
            ])
            .leftJoin('slot.joinInfo', 'joinInfo')
            .addSelect([
                'joinInfo'
            ])
            .leftJoin('slot.profile', 'profile')
            .addSelect([
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
            ])
        ;
        qb.leftJoin('lobby.joinHistory', 'joinHistory');
        qb.leftJoin('joinHistory.profile', 'joinHistoryProfile');
        qb.addSelect([
            'joinHistory.joinedAt',
            'joinHistory.leftAt',
            'joinHistoryProfile.regionId',
            'joinHistoryProfile.realmId',
            'joinHistoryProfile.profileId',
            'joinHistoryProfile.name',
            'joinHistoryProfile.discriminator',
        ]);
        const result = await qb
            .andWhere('lobby.status = :status OR lobby.closedAt >= FROM_UNIXTIME(UNIX_TIMESTAMP()-20)', { status: GameLobbyStatus.Open })
            .addOrderBy('lobby.createdAt', 'ASC')
            .addOrderBy('slot.slotNumber', 'ASC')
            .addOrderBy('joinInfo.id', 'ASC')
            .getMany()
        ;

        reply.header('Cache-control', 'public, s-maxage=1');
        return reply.type('application/json').code(200).send(result);
    });
});
