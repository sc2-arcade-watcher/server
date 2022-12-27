import fp from 'fastify-plugin';
import { S2Profile } from '../../../entity/S2Profile';
import { stripIndents } from 'common-tags';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/profiles/:regionId/:realmId/:profileId', {
        schema: {
            tags: ['Profiles'],
            summary: 'Info about player profile',
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
        const profile = await server.conn.getRepository(S2Profile)
            .createQueryBuilder('profile')
            .select([
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
                'profile.avatar',
                'profile.profileGameId',
                'profile.battleTag',
            ])
            .andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId', {
                regionId: request.params.regionId,
                realmId: request.params.realmId,
                profileId: request.params.profileId,
            })
            .limit(1)
            .getOne()
        ;

        if (!profile) {
            return reply.code(404).send();
        }

        reply.header('Cache-control', 'public, max-age=60');
        return reply.code(200).send(profile);
    });


    server.get<{
        Querystring: any,
        Params: any,
    }>('/profiles/:regionId/:profileGameId', {
        schema: {
            tags: ['Profiles'],
            summary: 'Info about player profile',
            description: stripIndents`
                Performs a search by \`{regionId}/{profileGameId}\`, where \`profileGameId\` is an identifier of a player profile, that's unique within the scope of region (as opposed to \`profileId\`, which is unique in scope of an \`{region/realm}\`).

                ---

                This data is obtained through several methods, but not all of them are fully automated - for the time being, it's guaranteed to be known for profiles that meet at least one of the following criteria:
                - Following profile has published a map/mod on arcade.
                - Following profile has left a review for a map/mod on arcade.
                - Following profile has joined the same chat channel (such as "#arcade" etc.), that the ArcadeWatcher bot was in at the time.

                ---

                ### Game links and data endianness

                \`profileGameId\` is used for SC2 compatible profile links, i.e. \`battlenet://starcraft/profile/{regionId}/{profileGameId}\`. However the identifier is stringified as big-endian u64, rather than little-endian u64, what it really is. Thus the number shown in a valid link appear to be big, but it's all about byte-order. See code examples below to learn how to quickly swap endianness.

                Swapping endianness
                - [in Python](https://onecompiler.com/python/3yt5tkzr9):
                \`\`\`py
                import struct

                def swap64(i):
                    return struct.unpack("<Q", struct.pack(">Q", i))[0]

                def sc2_profile_uri(region_id: int, profile_game_id: int):
                    return f'battlenet://starcraft/profile/{region_id}/{swap64(profile_game_id)}'

                print(sc2_profile_uri(2, 78294784))
                \`\`\`
                - [in JavaScript (browser compatible)](https://github.com/SC2-Arcade-Watcher/website/blob/d910a7a3ace7674e2beb38ac3f0f7b4f6dc95d49/src/starc-api/starc.ts#L564-L579)
            `,
            params: {
                type: 'object',
                required: ['regionId', 'profileGameId'],
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    profileGameId: {
                        type: 'number',
                    },
                },
            },
        },
    }, async (request, reply) => {
        const profile = await server.conn.getRepository(S2Profile)
            .createQueryBuilder('profile')
            .select([
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
                'profile.avatar',
                'profile.profileGameId',
                'profile.battleTag',
            ])
            .andWhere('profile.regionId = :regionId AND profile.profileGameId = :profileGameId', {
                regionId: request.params.regionId,
                profileGameId: request.params.profileGameId,
            })
            .limit(1)
            .getOne()
        ;

        if (!profile) {
            return reply.code(404).send();
        }

        reply.header('Cache-control', 'public, max-age=60');
        return reply.code(200).send(profile);
    });
});
