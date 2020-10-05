import fp from 'fastify-plugin';
import { S2Profile } from '../../../entity/S2Profile';
import { stripIndents } from 'common-tags';
import { S2Map } from '../../../entity/S2Map';
import { S2GameLobbyMap, S2GameLobbyMapKind } from '../../../entity/S2GameLobbyMap';
import { S2GameLobbySlot } from '../../../entity/S2GameLobbySlot';
import { S2GameLobby } from '../../../entity/S2GameLobby';
import { GameLobbyStatus } from '../../../gametracker';

interface PlayedMapRecord {
    map: S2Map;
    lobbiesStarted: number;
    lastPlayedAt: Date;
}

const reSnakeComponents = /_/g;

function compsCamelize(comps: string[]) {
    return comps.map((value, index) => {
        if (index === 0) return value;
        return value.substr(0, 1).toUpperCase() + value.substr(1);
    }).join('');
}

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/profiles/:regionId/:realmId/:profileId/summary', {
        schema: {
            tags: ['Profiles'],
            summary: 'Profile summary',
            description: stripIndents`
                NOTICE: This endpoint is not yet stable and might be changed in the future.
            `,
            params: {
                type: 'object',
                required: ['regionId', 'realmId', 'profileId'],
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    realmId: {
                        type: 'number',
                    },
                    profileId: {
                        type: 'number',
                    },
                },
            },
        },
    }, async (request, reply) => {
        const profileQuery = server.conn.getRepository(S2Profile).createQueryBuilder().subQuery()
            .from(S2Profile, 'profile')
            .select('profile.id')
            .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId')
            .limit(1)
            .getQuery()
        ;

        const rawResult = await server.conn.getRepository(S2GameLobbySlot).createQueryBuilder('lobSlot')
            .select([])
            .innerJoin(S2GameLobbyMap, 'lobMap', 'lobMap.lobby = lobSlot.lobby')
            .innerJoin(S2GameLobby, 'lob', 'lob.id = lobSlot.lobby')
            .innerJoin(S2Map, 'map', 'map.regionId = lobMap.regionId AND map.bnetId = lobMap.bnetId')
            .addSelect([
                'map.id',
                'map.regionId',
                'map.bnetId',
                'map.type',
                'map.name',
                'map.description',
                'map.website',
                'map.iconHash',
                'map.mainCategoryId',
                'map.maxPlayers',
                'map.updatedAt',
                'map.publishedAt',
            ])
            .addSelect('COUNT(*)', 'lobbies_started')
            .addSelect('MAX(lob.closedAt)', 'last_played_at')
            .andWhere(`lob.status = '${GameLobbyStatus.Started}'`)
            .andWhere(`lobMap.type IN ('${S2GameLobbyMapKind.Map}', '${S2GameLobbyMapKind.ExtensionMod}')`)
            .andWhere('lobSlot.profile = ' + profileQuery, {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            })
            .addGroupBy('lobMap.regionId')
            .addGroupBy('lobMap.bnetId')
            .orderBy('COUNT(*)', 'DESC')
            .getRawMany()
        ;

        const mostPlayed = rawResult.map(rawData => {
            const item: PlayedMapRecord = {} as any;
            item.map = new S2Map();
            for (const key of Object.keys(rawData)) {
                const comps = key.split(reSnakeComponents);
                if (comps[0] === 'map') {
                    (item.map as any)[compsCamelize(comps.slice(1))] = rawData[key];
                }
                else {
                    const camelKey = compsCamelize(comps);
                    switch (camelKey) {
                        case 'lobbiesStarted': {
                            (item as any)[camelKey] = Number(rawData[key]);
                            break;
                        }
                        default: {
                            (item as any)[camelKey] = rawData[key];
                            break;
                        }
                    }
                }
            }
            return item;
        });

        if (!mostPlayed.length) {
            return reply.code(404).send();
        }

        reply.header('Cache-control', 'public, max-age=60');
        return reply.code(200).send({
            mostPlayed: mostPlayed,
        });
    });
});
