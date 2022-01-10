import { fastify, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import fstatic from 'fastify-static';
import * as orm from 'typeorm';
import { atob, btoa } from '../../helpers';
import { AccountPrivileges } from '../../entity/AppAccount';

export interface CursorPaginationQuery {
    before: {[k: string]: string} | undefined;
    after: {[k: string]: string} | undefined;
    limit: number;
    fetchLimit: number;
    getOrderDirection: (order?: 'ASC' | 'DESC') => 'ASC' | 'DESC';
    getOperator: (dir: 'before' | 'after', order?: 'ASC' | 'DESC') => '>' | '<';
    applyQuery: (qb: orm.SelectQueryBuilder<any>, order?: 'ASC' | 'DESC') => orm.SelectQueryBuilder<any>;
    toRawKey: (s: string) => string;
    toFieldKey: (s: string) => string;
    toQueryKey: (s: string) => string;
    paginationKeys?: string[];
}

export interface CursorPaginationParams {
    paginationKeys?: string[] | string;
    toRawKey?: (s: string) => string;
    toFieldKey?: (s: string) => string;
    toQueryKey?: (s: string) => string;
}

export interface CursorPaginationInfo {
    prev: string | null;
    next: string | null;
}

export interface CursorPaginationResponse<T> {
    page: CursorPaginationInfo;
    results: T[];
}

type rawAndEntities<T> = {
    entities: T[];
    raw: any[];
};

type sendReplyType<T = any> = (this: FastifyReply, rData: rawAndEntities<T>, pQuery: CursorPaginationQuery) => CursorPaginationResponse<T>;

declare module 'fastify' {
    interface FastifyRequest {
        parseCursorPagination(this: FastifyRequest, opts?: CursorPaginationParams): CursorPaginationQuery;
    }

    interface FastifyReply {
        sendWithCursorPagination: sendReplyType;
    }
}

const defaultLimit = 50;
const maximumLimit = 500;

export default fp(async (server, opts) => {
    server.decorateRequest('parseCursorPagination', function (this: FastifyRequest<{ Querystring: any }>, opts: CursorPaginationParams = {}) {
        let limit = parseInt(this.query.limit);
        if (Number.isNaN(limit)) {
            limit = defaultLimit;
        }
        else {
            if (this.userAccount?.privileges & AccountPrivileges.SuperAdmin) {
                limit = Math.min(100000, Math.max(limit, 1));
            }
            else {
                limit = Math.min(maximumLimit, Math.max(limit, 1));
            }
        }

        const pq: CursorPaginationQuery = {
            limit: limit,
            fetchLimit: limit + 1,
            paginationKeys: ['id'],
        } as CursorPaginationQuery;
        if (typeof opts.paginationKeys === 'string') {
            pq.paginationKeys = [opts.paginationKeys];
        }
        else if (typeof opts.paginationKeys === 'object') {
            pq.paginationKeys = opts.paginationKeys;
        }

        function toRawKey(s: string) {
            const r = s.split('.');
            return [r.shift(), ...r.map(server.conn.namingStrategy.relationName)].join('_');
        }
        pq.toRawKey = opts.toRawKey ?? toRawKey;
        pq.toFieldKey = opts.toFieldKey ?? pq.toRawKey;
        pq.toQueryKey = opts.toQueryKey ?? pq.toRawKey;

        function decodeKeyValues(value: string) {
            if (!value) return void 0;
            const kvals = JSON.parse(atob(value));
            if (!Array.isArray(kvals)) return void 0;
            const kvmap: {[k: string]: string} = {};
            for (const k of pq.paginationKeys) {
                kvmap[pq.toFieldKey(k)] = kvals.length ? kvals.shift() : null;
            }
            return kvmap;
        }

        pq.before = decodeKeyValues(this.query.before);
        pq.after = decodeKeyValues(this.query.after);

        pq.getOrderDirection = (order?) => {
            if (!order) order = 'ASC';
            if (pq.before && order === 'ASC') return 'DESC';
            if (pq.before && order === 'DESC') return 'ASC';
            return order;
        };

        pq.getOperator = (dir: 'before' | 'after', order?: 'ASC' | 'DESC') => {
            if (dir === 'before' && pq.getOrderDirection(order) === 'ASC') {
                return '>';
            }
            else if (dir === 'before' && pq.getOrderDirection(order) === 'DESC') {
                return '<';
            }
            else if (dir === 'after' && pq.getOrderDirection(order) === 'ASC') {
                return '>';
            }
            else if (dir === 'after' && pq.getOrderDirection(order) === 'DESC') {
                return '<';
            }
        };

        pq.applyQuery = (qb, order) => {
            const dir = pq.before ? 'before' : pq.after ? 'after' : null;
            for (const k of pq.paginationKeys) {
                if (dir) {
                    qb.andWhere(k + ' ' + pq.getOperator(dir, order) + ' :' + pq.toQueryKey(k));
                }
                qb.addOrderBy(k, pq.getOrderDirection(order));
            }
            if (dir) {
                qb.setParameters(pq[dir]);
            }
            return qb;
        };

        return pq;
    });

    server.decorateReply('sendWithCursorPagination', function<T> (this: FastifyReply, rData: rawAndEntities<T>, pQuery: CursorPaginationQuery) {
        function encodeKeyValues(entry: T) {
            const kvals: string[] = [];
            const rawKeys = pQuery.paginationKeys.map(pQuery.toRawKey);
            for (const k of rawKeys) {
                kvals.push((<any>entry)[k]);
            }
            // for (const k of pQuery.paginationKeys) {
            //     let tmpval: string | any = entry;
            //     for (const ksub of k.split('.')) {
            //         tmpval = (<any>tmpval)[ksub];
            //         if (tmpval === void 0 || tmpval === null) {
            //             tmpval = '';
            //             break;
            //         }
            //     }
            //     kvals.push(tmpval);
            // }
            return btoa(JSON.stringify(kvals));
        }

        const presponse: CursorPaginationResponse<T> = {
            page: {
                prev: null,
                next: null,
            },
            results: rData.entities,
        };
        if (pQuery.before) {
            if (rData.entities.length) {
                presponse.page.next = encodeKeyValues(rData.raw[0]);
            }
            if (rData.entities.length > pQuery.limit) {
                presponse.page.prev = encodeKeyValues(rData.raw[pQuery.limit - 1]);
                presponse.results = rData.entities.slice(0, pQuery.limit);
            }
            presponse.results = presponse.results.reverse();
        }
        else {
            if (pQuery.after) {
                if (rData.entities.length) {
                    presponse.page.prev = encodeKeyValues(rData.raw[0]);
                }
            }
            if (rData.entities.length > pQuery.limit) {
                presponse.page.next = encodeKeyValues(rData.raw[pQuery.limit - 1]);
                presponse.results = rData.entities.slice(0, pQuery.limit);
            }
        }

        // strip ids
        if (pQuery.paginationKeys[0].split('.').pop() === 'id') {
            presponse.results.map(x => { delete (x as any).id; });
        }

        return presponse;
    });
});
