import fp from 'fastify-plugin';
import { S2Profile } from '../../../entity/S2Profile';
import { parseProfileHandle } from '../../../bnet/common';
import { stripIndents } from 'common-tags';

export default fp(async (server, opts) => {
    server.get<{
        Querystring: any,
        Params: any,
    }>('/profiles', {
        schema: {
            tags: ['Profiles'],
            summary: 'List of player profiles',
            description: stripIndents`
                NOTICE: This endpoint is not yet stable and might be changed in the future.
            `,
            querystring: {
                type: 'object',
                properties: {
                    regionId: {
                        type: 'number',
                    },
                    name: {
                        type: 'string',
                    },
                    profileHandle: {
                        type: 'string',
                    },
                    orderDirection: {
                        type: 'string',
                        enum: [
                            'asc',
                            'desc',
                        ],
                        default: 'desc',
                    },
                    orderBy: {
                        type: 'string',
                        enum: [
                            'id',
                            'profileId',
                            'name',
                            'lastOnlineAt',
                        ],
                        default: 'name',
                    },
                },
            },
        },
    }, async (request, reply) => {
        let orderByKey: string | string[];
        switch (request.query.orderBy) {
            case 'id':
            case 'name':
            case 'lastOnlineAt': {
                orderByKey = `profile.${request.query.orderBy}`;
                break;
            }
            case 'profileId': {
                orderByKey = [
                    'profile.regionId',
                    'profile.realmId',
                    'profile.profileId',
                ];
                break;
            }
        }

        const pQuery = request.parseCursorPagination({
            paginationKeys: orderByKey,
        });

        const qb = server.conn.getRepository(S2Profile)
            .createQueryBuilder('profile')
            .select([
                'profile.regionId',
                'profile.realmId',
                'profile.profileId',
                'profile.name',
                'profile.discriminator',
                'profile.avatar',
                'profile.lastOnlineAt',
            ])
            .limit(pQuery.fetchLimit)
        ;

        if (request.query.profileHandle !== void 0) {
            const requestedProfile = parseProfileHandle(request.query.profileHandle) ?? { regionId: 0, realmId: 0, profileId: 0 };
            qb.andWhere('profile.regionId = :regionId AND profile.realmId = :realmId AND profile.profileId = :profileId', requestedProfile);
        }
        else {
            qb.andWhere('profile.deleted = 0');
        }

        if (request.query.regionId !== void 0) {
            qb.andWhere('profile.regionId = :regionId', { regionId: request.query.regionId });
        }

        if (request.query.name !== void 0 && request.query.name.trim().length > 2) {
            const nameQuery = (request.query.name as string).replace(/([\%\?])/g, '\\$1');

            if (nameQuery.length) {
                if (nameQuery.indexOf('#') > 0) {
                    qb.andWhere('profile.name LIKE :name', { name: nameQuery.substr(0, nameQuery.indexOf('#')) });
                    const discriminator = Number(nameQuery.substr(nameQuery.indexOf('#') + 1));
                    if (discriminator && !isNaN(discriminator)) {
                        qb.andWhere('profile.discriminator = :discriminator', { discriminator });
                    }
                }
                else {
                    qb.andWhere('profile.name LIKE :name', { name: nameQuery + '%' });
                }
            }
        }

        pQuery.applyQuery(qb, request.query.orderDirection?.toUpperCase());

        return reply.code(200).sendWithCursorPagination(await qb.getRawAndEntities(), pQuery);
    });
});
